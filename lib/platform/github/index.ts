import URL from 'url';
import is from '@sindresorhus/is';
import delay from 'delay';
import JSON5 from 'json5';
import { DateTime } from 'luxon';
import { valid as semverValid } from 'semver';
import { PlatformId } from '../../constants';
import {
  PLATFORM_INTEGRATION_UNAUTHORIZED,
  REPOSITORY_ACCESS_FORBIDDEN,
  REPOSITORY_ARCHIVED,
  REPOSITORY_BLOCKED,
  REPOSITORY_CANNOT_FORK,
  REPOSITORY_CHANGED,
  REPOSITORY_DISABLED,
  REPOSITORY_EMPTY,
  REPOSITORY_FORKED,
  REPOSITORY_NOT_FOUND,
  REPOSITORY_RENAMED,
} from '../../constants/error-messages';
import { logger } from '../../logger';
import { BranchStatus, PrState, VulnerabilityAlert } from '../../types';
import { ExternalHostError } from '../../types/errors/external-host-error';
import * as git from '../../util/git';
import * as hostRules from '../../util/host-rules';
import * as githubHttp from '../../util/http/github';
import { regEx } from '../../util/regex';
import { sanitize } from '../../util/sanitize';
import { ensureTrailingSlash } from '../../util/url';
import type {
  AggregatedVulnerabilities,
  BranchStatusConfig,
  CreatePRConfig,
  EnsureCommentConfig,
  EnsureCommentRemovalConfig,
  EnsureIssueConfig,
  EnsureIssueResult,
  FindPRConfig,
  Issue,
  MergePRConfig,
  PlatformParams,
  PlatformPrOptions,
  PlatformResult,
  Pr,
  RepoParams,
  RepoResult,
  UpdatePrConfig,
} from '../types';
import { smartTruncate } from '../utils/pr-body';
import {
  closedPrsQuery,
  enableAutoMergeMutation,
  getIssuesQuery,
  openPrsQuery,
  repoInfoQuery,
  vulnerabilityAlertsQuery,
} from './graphql';
import { massageMarkdownLinks } from './massage-markdown-links';
import {
  BranchProtection,
  CombinedBranchStatus,
  Comment,
  GhAutomergeResponse,
  GhBranchStatus,
  GhGraphQlPr,
  GhRepo,
  GhRestPr,
  LocalRepoConfig,
  PlatformConfig,
  PrList,
} from './types';
import { UserDetails, getUserDetails, getUserEmail } from './user';

const githubApi = new githubHttp.GithubHttp();

let config: LocalRepoConfig = {} as any;

const platformConfig: PlatformConfig = {
  hostType: PlatformId.Github,
  endpoint: 'https://api.github.com/',
};

const escapeHash = (input: string): string =>
  input ? input.replace(regEx(/#/g), '%23') : input;

export async function detectGhe(token: string): Promise<void> {
  platformConfig.isGhe =
    URL.parse(platformConfig.endpoint).host !== 'api.github.com';
  if (platformConfig.isGhe) {
    const gheHeaderKey = 'x-github-enterprise-version';
    const gheQueryRes = await githubApi.headJson('/', { token });
    const gheHeaders: Record<string, string> = gheQueryRes?.headers || {};
    const [, gheVersion] =
      Object.entries(gheHeaders).find(
        ([k]) => k.toLowerCase() === gheHeaderKey
      ) ?? [];
    platformConfig.gheVersion = semverValid(gheVersion) ?? null;
  }
}

export async function initPlatform({
  endpoint,
  token,
  username,
  gitAuthor,
}: PlatformParams): Promise<PlatformResult> {
  if (!token) {
    throw new Error('Init: You must configure a GitHub personal access token');
  }

  if (endpoint) {
    platformConfig.endpoint = ensureTrailingSlash(endpoint);
    githubHttp.setBaseUrl(platformConfig.endpoint);
  } else {
    logger.debug('Using default github endpoint: ' + platformConfig.endpoint);
  }

  await detectGhe(token);

  let userDetails: UserDetails;
  let renovateUsername: string;
  if (username) {
    renovateUsername = username;
  } else {
    userDetails = await getUserDetails(platformConfig.endpoint, token);
    renovateUsername = userDetails.username;
  }
  let discoveredGitAuthor: string;
  if (!gitAuthor) {
    userDetails = await getUserDetails(platformConfig.endpoint, token);
    const userEmail = await getUserEmail(platformConfig.endpoint, token);
    if (userEmail) {
      discoveredGitAuthor = `${userDetails.name} <${userEmail}>`;
    }
  }
  logger.debug({ platformConfig, renovateUsername }, 'Platform config');
  const platformResult: PlatformResult = {
    endpoint: platformConfig.endpoint,
    gitAuthor: gitAuthor || discoveredGitAuthor,
    renovateUsername,
  };

  return platformResult;
}

// Get all repositories that the user has access to
export async function getRepos(): Promise<string[]> {
  logger.debug('Autodiscovering GitHub repositories');
  try {
    const res = await githubApi.getJson<{ full_name: string }[]>(
      'user/repos?per_page=100',
      { paginate: 'all' }
    );
    return res.body.map((repo) => repo.full_name);
  } catch (err) /* istanbul ignore next */ {
    logger.error({ err }, `GitHub getRepos error`);
    throw err;
  }
}

async function getBranchProtection(
  branchName: string
): Promise<BranchProtection> {
  // istanbul ignore if
  if (config.parentRepo) {
    return {};
  }
  const res = await githubApi.getJson<BranchProtection>(
    `repos/${config.repository}/branches/${escapeHash(branchName)}/protection`
  );
  return res.body;
}

export async function getRawFile(
  fileName: string,
  repoName: string = config.repository
): Promise<string | null> {
  const url = `repos/${repoName}/contents/${fileName}`;
  const res = await githubApi.getJson<{ content: string }>(url);
  const buf = res.body.content;
  const str = Buffer.from(buf, 'base64').toString();
  return str;
}

export async function getJsonFile(
  fileName: string,
  repoName: string = config.repository
): Promise<any | null> {
  const raw = await getRawFile(fileName, repoName);
  if (fileName.endsWith('.json5')) {
    return JSON5.parse(raw);
  }
  return JSON.parse(raw);
}

let existingRepos;

// Initialize GitHub by getting base branch and SHA
export async function initRepo({
  endpoint,
  repository,
  forkMode,
  forkToken,
  renovateUsername,
  cloneSubmodules,
  ignorePrAuthor,
}: RepoParams): Promise<RepoResult> {
  logger.debug(`initRepo("${repository}")`);
  // config is used by the platform api itself, not necessary for the app layer to know
  config = {
    repository,
    cloneSubmodules,
    ignorePrAuthor,
  } as any;
  // istanbul ignore if
  if (endpoint) {
    // Necessary for Renovate Pro - do not remove
    logger.debug({ endpoint }, 'Overriding default GitHub endpoint');
    platformConfig.endpoint = endpoint;
    githubHttp.setBaseUrl(endpoint);
  }
  const opts = hostRules.find({
    hostType: PlatformId.Github,
    url: platformConfig.endpoint,
  });
  config.renovateUsername = renovateUsername;
  [config.repositoryOwner, config.repositoryName] = repository.split('/');
  let repo: GhRepo;
  try {
    let infoQuery = repoInfoQuery;

    if (platformConfig.isGhe) {
      infoQuery = infoQuery.replace(/\n\s*autoMergeAllowed\s*\n/, '\n');
      infoQuery = infoQuery.replace(/\n\s*hasIssuesEnabled\s*\n/, '\n');
    }

    const res = await githubApi.requestGraphql<{
      repository: GhRepo;
    }>(infoQuery, {
      variables: {
        owner: config.repositoryOwner,
        name: config.repositoryName,
      },
    });
    repo = res?.data?.repository;
    // istanbul ignore if
    if (!repo) {
      throw new Error(REPOSITORY_NOT_FOUND);
    }
    // istanbul ignore if
    if (!repo.defaultBranchRef?.name) {
      throw new Error(REPOSITORY_EMPTY);
    }
    if (repo.nameWithOwner && repo.nameWithOwner !== repository) {
      logger.debug(
        { repository, this_repository: repo.nameWithOwner },
        'Repository has been renamed'
      );
      throw new Error(REPOSITORY_RENAMED);
    }
    if (repo.isArchived) {
      logger.debug(
        'Repository is archived - throwing error to abort renovation'
      );
      throw new Error(REPOSITORY_ARCHIVED);
    }
    // Use default branch as PR target unless later overridden.
    config.defaultBranch = repo.defaultBranchRef.name;
    // Base branch may be configured but defaultBranch is always fixed
    logger.debug(`${repository} default branch = ${config.defaultBranch}`);
    // GitHub allows administrators to block certain types of merge, so we need to check it
    if (repo.rebaseMergeAllowed) {
      config.mergeMethod = 'rebase';
    } else if (repo.squashMergeAllowed) {
      config.mergeMethod = 'squash';
    } else if (repo.mergeCommitAllowed) {
      config.mergeMethod = 'merge';
    } else {
      // This happens if we don't have Administrator read access, it is not a critical error
      logger.debug('Could not find allowed merge methods for repo');
    }
    config.autoMergeAllowed = repo.autoMergeAllowed;
    config.hasIssuesEnabled = repo.hasIssuesEnabled;
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ err }, 'Caught initRepo error');
    if (
      err.message === REPOSITORY_ARCHIVED ||
      err.message === REPOSITORY_RENAMED ||
      err.message === REPOSITORY_NOT_FOUND
    ) {
      throw err;
    }
    if (err.statusCode === 403) {
      throw new Error(REPOSITORY_ACCESS_FORBIDDEN);
    }
    if (err.statusCode === 404) {
      throw new Error(REPOSITORY_NOT_FOUND);
    }
    if (err.message.startsWith('Repository access blocked')) {
      throw new Error(REPOSITORY_BLOCKED);
    }
    if (err.message === REPOSITORY_FORKED) {
      throw err;
    }
    if (err.message === REPOSITORY_DISABLED) {
      throw err;
    }
    if (err.message === 'Response code 451 (Unavailable for Legal Reasons)') {
      throw new Error(REPOSITORY_ACCESS_FORBIDDEN);
    }
    logger.debug({ err }, 'Unknown GitHub initRepo error');
    throw err;
  }
  // This shouldn't be necessary, but occasional strange errors happened until it was added
  config.issueList = null;
  config.prList = null;
  config.openPrList = null;
  config.closedPrList = null;
  config.branchPrs = [];

  config.forkMode = !!forkMode;
  if (forkMode) {
    logger.debug('Bot is in forkMode');
    config.forkToken = forkToken;
    // save parent name then delete
    config.parentRepo = config.repository;
    config.repository = null;
    // Get list of existing repos
    existingRepos =
      existingRepos ||
      (
        await githubApi.getJson<{ full_name: string }[]>(
          'user/repos?per_page=100',
          {
            token: forkToken || opts.token,
            paginate: true,
            pageLimit: 100,
          }
        )
      ).body.map((r) => r.full_name);
    try {
      const forkedRepo = await githubApi.postJson<{
        full_name: string;
        default_branch: string;
      }>(`repos/${repository}/forks`, {
        token: forkToken || opts.token,
      });
      config.repository = forkedRepo.body.full_name;
      const forkDefaultBranch = forkedRepo.body.default_branch;
      if (forkDefaultBranch !== config.defaultBranch) {
        const body = {
          ref: `refs/heads/${config.defaultBranch}`,
          sha: repo.defaultBranchRef.target.oid,
        };
        logger.debug(
          {
            defaultBranch: config.defaultBranch,
            forkDefaultBranch,
            body,
          },
          'Fork has different default branch to parent, attempting to create branch'
        );
        try {
          await githubApi.postJson(`repos/${config.repository}/git/refs`, {
            body,
            token: forkToken,
          });
          logger.debug('Created new default branch in fork');
        } catch (err) /* istanbul ignore next */ {
          if (err.response?.body?.message === 'Reference already exists') {
            logger.debug(
              `Branch ${config.defaultBranch} already exists in the fork`
            );
          } else {
            logger.warn(
              { err, body: err.response?.body },
              'Could not create parent defaultBranch in fork'
            );
          }
        }
        logger.debug(
          `Setting ${config.defaultBranch} as default branch for ${config.repository}`
        );
        try {
          await githubApi.patchJson(`repos/${config.repository}`, {
            body: {
              name: config.repository.split('/')[1],
              default_branch: config.defaultBranch,
            },
            token: forkToken,
          });
          logger.debug('Successfully changed default branch for fork');
        } catch (err) /* istanbul ignore next */ {
          logger.warn({ err }, 'Could not set default branch');
        }
      }
    } catch (err) /* istanbul ignore next */ {
      logger.debug({ err }, 'Error forking repository');
      throw new Error(REPOSITORY_CANNOT_FORK);
    }
    if (existingRepos.includes(config.repository)) {
      logger.debug(
        { repository_fork: config.repository },
        'Found existing fork'
      );
      // This is a lovely "hack" by GitHub that lets us force update our fork's default branch
      // with the base commit from the parent repository
      try {
        logger.debug(
          'Updating forked repository default sha to match upstream'
        );
        await githubApi.patchJson(
          `repos/${config.repository}/git/refs/heads/${config.defaultBranch}`,
          {
            body: {
              sha: repo.defaultBranchRef.target.oid,
              force: true,
            },
            token: forkToken || opts.token,
          }
        );
      } catch (err) /* istanbul ignore next */ {
        logger.warn(
          { err: err.err || err },
          'Error updating fork from upstream - cannot continue'
        );
        if (err instanceof ExternalHostError) {
          throw err;
        }
        throw new ExternalHostError(err);
      }
    } else {
      logger.debug({ repository_fork: config.repository }, 'Created fork');
      existingRepos.push(config.repository);
      // Wait an arbitrary 30s to hopefully give GitHub enough time for forking to complete
      await delay(30000);
    }
  }

  const parsedEndpoint = URL.parse(platformConfig.endpoint);
  // istanbul ignore else
  if (forkMode) {
    logger.debug('Using forkToken for git init');
    parsedEndpoint.auth = config.forkToken;
  } else {
    const tokenType = opts.token?.startsWith('x-access-token:')
      ? 'app'
      : 'personal access';
    logger.debug(`Using ${tokenType} token for git init`);
    parsedEndpoint.auth = opts.token;
  }
  parsedEndpoint.host = parsedEndpoint.host.replace(
    'api.github.com',
    'github.com'
  );
  parsedEndpoint.pathname = config.repository + '.git';
  const url = URL.format(parsedEndpoint);
  await git.initRepo({
    ...config,
    url,
  });
  const repoConfig: RepoResult = {
    defaultBranch: config.defaultBranch,
    isFork: repo.isFork === true,
  };
  return repoConfig;
}

export async function getRepoForceRebase(): Promise<boolean> {
  if (config.repoForceRebase === undefined) {
    try {
      config.repoForceRebase = false;
      const branchProtection = await getBranchProtection(config.defaultBranch);
      logger.debug('Found branch protection');
      if (branchProtection.required_pull_request_reviews) {
        logger.debug(
          'Branch protection: PR Reviews are required before merging'
        );
        config.prReviewsRequired = true;
      }
      if (branchProtection.required_status_checks) {
        if (branchProtection.required_status_checks.strict) {
          logger.debug(
            'Branch protection: PRs must be up-to-date before merging'
          );
          config.repoForceRebase = true;
        }
      }
      if (branchProtection.restrictions) {
        logger.debug(
          {
            users: branchProtection.restrictions.users,
            teams: branchProtection.restrictions.teams,
          },
          'Branch protection: Pushing to branch is restricted'
        );
        config.pushProtection = true;
      }
    } catch (err) {
      if (err.statusCode === 404) {
        logger.debug(`No branch protection found`);
      } else if (
        err.message === PLATFORM_INTEGRATION_UNAUTHORIZED ||
        err.statusCode === 403
      ) {
        logger.debug(
          'Branch protection: Do not have permissions to detect branch protection'
        );
      } else {
        throw err;
      }
    }
  }
  return config.repoForceRebase;
}

async function getClosedPrs(): Promise<PrList> {
  if (!config.closedPrList) {
    config.closedPrList = {};
    try {
      // prettier-ignore
      const nodes = await githubApi.queryRepoField<GhGraphQlPr>(
        closedPrsQuery,
        'pullRequests',
        {
          variables: {
            owner: config.repositoryOwner,
            name: config.repositoryName,
          },
        }
      );
      const prNumbers: number[] = [];
      // istanbul ignore if
      if (!nodes?.length) {
        logger.debug('getClosedPrs(): no graphql data');
        return {};
      }
      for (const pr of nodes) {
        // https://developer.github.com/v4/object/pullrequest/
        pr.displayNumber = `Pull Request #${pr.number}`;
        pr.state = pr.state.toLowerCase();
        pr.sourceBranch = pr.headRefName;
        delete pr.headRefName;
        pr.comments = pr.comments.nodes.map((comment) => ({
          id: comment.databaseId,
          body: comment.body,
        }));
        pr.body = 'dummy body'; // just in case
        config.closedPrList[pr.number] = pr;
        prNumbers.push(pr.number);
      }
      prNumbers.sort();
      logger.debug({ prNumbers }, 'Retrieved closed PR list with graphql');
    } catch (err) /* istanbul ignore next */ {
      logger.warn({ err }, 'getClosedPrs(): error');
    }
  }
  return config.closedPrList;
}

async function getOpenPrs(): Promise<PrList> {
  // The graphql query is supported in the current oldest GHE version 2.19
  if (!config.openPrList) {
    config.openPrList = {};
    try {
      // prettier-ignore
      const nodes = await githubApi.queryRepoField<GhGraphQlPr>(
        openPrsQuery,
        'pullRequests',
        {
          variables: {
            owner: config.repositoryOwner,
            name: config.repositoryName,
          },
          acceptHeader: 'application/vnd.github.merge-info-preview+json',
        }
      );
      const prNumbers: number[] = [];
      // istanbul ignore if
      if (!nodes?.length) {
        logger.debug('getOpenPrs(): no graphql data');
        return {};
      }
      for (const pr of nodes) {
        // https://developer.github.com/v4/object/pullrequest/
        pr.displayNumber = `Pull Request #${pr.number}`;
        pr.state = PrState.Open;
        pr.sourceBranch = pr.headRefName;
        delete pr.headRefName;
        pr.targetBranch = pr.baseRefName;
        delete pr.baseRefName;
        // https://developer.github.com/v4/enum/mergeablestate
        const canMergeStates = ['BEHIND', 'CLEAN', 'HAS_HOOKS', 'UNSTABLE'];
        const hasNegativeReview = pr.reviews?.nodes?.length > 0;
        // istanbul ignore if
        if (hasNegativeReview) {
          pr.canMerge = false;
          pr.canMergeReason = `hasNegativeReview`;
        } else if (canMergeStates.includes(pr.mergeStateStatus)) {
          pr.canMerge = true;
        } else if (config.forkToken && pr.mergeStateStatus === 'BLOCKED') {
          // The main token can't merge but maybe the forking token can
          // istanbul ignore next
          pr.canMerge = true;
        } else {
          pr.canMerge = false;
          pr.canMergeReason = `mergeStateStatus = ${pr.mergeStateStatus}`;
        }
        // https://developer.github.com/v4/enum/mergestatestatus
        if (pr.mergeStateStatus === 'DIRTY') {
          pr.isConflicted = true;
        } else {
          pr.isConflicted = false;
        }
        if (pr.labels) {
          pr.labels = pr.labels.nodes.map((label) => label.name);
        }
        pr.hasAssignees = !!(pr.assignees?.totalCount > 0);
        delete pr.assignees;
        pr.hasReviewers = !!(pr.reviewRequests?.totalCount > 0);
        delete pr.reviewRequests;
        delete pr.mergeable;
        delete pr.mergeStateStatus;
        delete pr.commits;
        config.openPrList[pr.number] = pr;
        prNumbers.push(pr.number);
      }
      prNumbers.sort();
      logger.trace({ prNumbers }, 'Retrieved open PR list with graphql');
    } catch (err) /* istanbul ignore next */ {
      logger.warn({ err }, 'getOpenPrs(): error');
    }
  }
  return config.openPrList;
}

// Gets details for a PR
export async function getPr(prNo: number): Promise<Pr | null> {
  if (!prNo) {
    return null;
  }
  const openPrs = await getOpenPrs();
  const openPr = openPrs[prNo];
  if (openPr) {
    logger.debug('Returning from graphql open PR list');
    return openPr;
  }
  const closedPrs = await getClosedPrs();
  const closedPr = closedPrs[prNo];
  if (closedPr) {
    logger.debug('Returning from graphql closed PR list');
    return closedPr;
  }
  logger.debug(
    { prNo },
    'PR not found in open or closed PRs list - trying to fetch it directly'
  );
  const pr = (
    await githubApi.getJson<GhRestPr>(
      `repos/${config.parentRepo || config.repository}/pulls/${prNo}`
    )
  ).body;
  if (!pr) {
    return null;
  }
  // Harmonise PR values
  pr.displayNumber = `Pull Request #${pr.number}`;
  if (pr.state === PrState.Open) {
    pr.sourceBranch = pr.head ? pr.head.ref : undefined;
    pr.sha = pr.head ? pr.head.sha : undefined;
    if (pr.mergeable === true) {
      pr.canMerge = true;
    } else {
      pr.canMerge = false;
      pr.canMergeReason = `mergeable = ${pr.mergeable}`;
    }
    if (pr.mergeable_state === 'dirty') {
      logger.debug({ prNo }, 'PR state is dirty so unmergeable');
      pr.isConflicted = true;
    }
  }
  return pr;
}

function matchesState(state: string, desiredState: string): boolean {
  if (desiredState === PrState.All) {
    return true;
  }
  if (desiredState.startsWith('!')) {
    return state !== desiredState.substring(1);
  }
  return state === desiredState;
}

export async function getPrList(): Promise<Pr[]> {
  logger.trace('getPrList()');
  if (!config.prList) {
    logger.debug('Retrieving PR list');
    let prList: GhRestPr[];
    try {
      prList = (
        await githubApi.getJson<GhRestPr[]>(
          `repos/${
            config.parentRepo || config.repository
          }/pulls?per_page=100&state=all`,
          { paginate: true }
        )
      ).body;
    } catch (err) /* istanbul ignore next */ {
      logger.debug({ err }, 'getPrList err');
      throw new ExternalHostError(err, PlatformId.Github);
    }
    config.prList = prList
      .filter(
        (pr) =>
          config.forkMode ||
          config.ignorePrAuthor ||
          (pr?.user?.login && config?.renovateUsername
            ? pr.user.login === config.renovateUsername
            : true)
      )
      .map(
        (pr) =>
          ({
            number: pr.number,
            sourceBranch: pr.head.ref,
            sha: pr.head.sha,
            title: pr.title,
            state:
              pr.state === PrState.Closed && pr.merged_at?.length
                ? /* istanbul ignore next */ PrState.Merged
                : pr.state,
            createdAt: pr.created_at,
            closedAt: pr.closed_at,
            sourceRepo: pr.head?.repo?.full_name,
          } as never)
      );
    logger.debug(`Retrieved ${config.prList.length} Pull Requests`);
  }
  return config.prList;
}

export async function findPr({
  branchName,
  prTitle,
  state = PrState.All,
}: FindPRConfig): Promise<Pr | null> {
  logger.debug(`findPr(${branchName}, ${prTitle}, ${state})`);
  const prList = await getPrList();
  const pr = prList.find(
    (p) =>
      p.sourceBranch === branchName &&
      (!prTitle || p.title === prTitle) &&
      matchesState(p.state, state) &&
      (config.forkMode || config.repository === p.sourceRepo) // #5188
  );
  if (pr) {
    logger.debug(`Found PR #${pr.number}`);
  }
  return pr;
}

const REOPEN_THRESHOLD_MILLIS = 1000 * 60 * 60 * 24 * 7;

// Returns the Pull Request for a branch. Null if not exists.
export async function getBranchPr(branchName: string): Promise<Pr | null> {
  // istanbul ignore if
  if (config.branchPrs[branchName]) {
    return config.branchPrs[branchName];
  }
  logger.debug(`getBranchPr(${branchName})`);
  const openPr = await findPr({
    branchName,
    state: PrState.Open,
  });
  if (openPr) {
    config.branchPrs[branchName] = await getPr(openPr.number);
    return config.branchPrs[branchName];
  }
  const autoclosedPr = await findPr({
    branchName,
    state: PrState.Closed,
  });
  if (
    autoclosedPr?.title?.endsWith(' - autoclosed') &&
    autoclosedPr?.closedAt
  ) {
    const closedMillisAgo = DateTime.fromISO(autoclosedPr.closedAt)
      .diffNow()
      .negate()
      .toMillis();
    if (closedMillisAgo > REOPEN_THRESHOLD_MILLIS) {
      return null;
    }
    logger.debug({ autoclosedPr }, 'Found autoclosed PR for branch');
    const { sha, number } = autoclosedPr;
    try {
      await githubApi.postJson(`repos/${config.repository}/git/refs`, {
        body: { ref: `refs/heads/${branchName}`, sha },
      });
      logger.debug({ branchName, sha }, 'Recreated autoclosed branch');
    } catch (err) {
      logger.debug('Could not recreate autoclosed branch - skipping reopen');
      return null;
    }
    try {
      const title = autoclosedPr.title.replace(regEx(/ - autoclosed$/), '');
      await githubApi.patchJson(`repos/${config.repository}/pulls/${number}`, {
        body: {
          state: 'open',
          title,
        },
      });
      logger.info(
        { branchName, title, number },
        'Successfully reopened autoclosed PR'
      );
    } catch (err) {
      logger.debug('Could not reopen autoclosed PR');
      return null;
    }
    delete config.openPrList; // So that it gets refreshed
    delete config.closedPrList?.[number]; // So that it's no longer found in the closed list
    config.branchPrs[branchName] = await getPr(number);
    return config.branchPrs[branchName];
  }
  return null;
}

async function getStatus(
  branchName: string,
  useCache = true
): Promise<CombinedBranchStatus> {
  const commitStatusUrl = `repos/${config.repository}/commits/${escapeHash(
    branchName
  )}/status`;

  return (
    await githubApi.getJson<CombinedBranchStatus>(commitStatusUrl, { useCache })
  ).body;
}

// Returns the combined status for a branch.
export async function getBranchStatus(
  branchName: string
): Promise<BranchStatus> {
  logger.debug(`getBranchStatus(${branchName})`);
  let commitStatus: CombinedBranchStatus;
  try {
    commitStatus = await getStatus(branchName);
  } catch (err) /* istanbul ignore next */ {
    if (err.statusCode === 404) {
      logger.debug(
        'Received 404 when checking branch status, assuming that branch has been deleted'
      );
      throw new Error(REPOSITORY_CHANGED);
    }
    logger.debug('Unknown error when checking branch status');
    throw err;
  }
  logger.debug(
    { state: commitStatus.state, statuses: commitStatus.statuses },
    'branch status check result'
  );
  let checkRuns: { name: string; status: string; conclusion: string }[] = [];
  // API is supported in oldest available GHE version 2.19
  try {
    const checkRunsUrl = `repos/${config.repository}/commits/${escapeHash(
      branchName
    )}/check-runs?per_page=100`;
    const opts = {
      headers: {
        accept: 'application/vnd.github.antiope-preview+json',
      },
      paginate: true,
      paginationField: 'check_runs',
    };
    const checkRunsRaw = (
      await githubApi.getJson<{
        check_runs: { name: string; status: string; conclusion: string }[];
      }>(checkRunsUrl, opts)
    ).body;
    if (checkRunsRaw.check_runs?.length) {
      checkRuns = checkRunsRaw.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      }));
      logger.debug({ checkRuns }, 'check runs result');
    } else {
      // istanbul ignore next
      logger.debug({ result: checkRunsRaw }, 'No check runs found');
    }
  } catch (err) /* istanbul ignore next */ {
    if (err instanceof ExternalHostError) {
      throw err;
    }
    if (
      err.statusCode === 403 ||
      err.message === PLATFORM_INTEGRATION_UNAUTHORIZED
    ) {
      logger.debug('No permission to view check runs');
    } else {
      logger.warn({ err }, 'Error retrieving check runs');
    }
  }
  if (checkRuns.length === 0) {
    if (commitStatus.state === 'success') {
      return BranchStatus.green;
    }
    if (commitStatus.state === 'failure') {
      return BranchStatus.red;
    }
    return BranchStatus.yellow;
  }
  if (
    commitStatus.state === 'failure' ||
    checkRuns.some((run) => run.conclusion === 'failure')
  ) {
    return BranchStatus.red;
  }
  if (
    (commitStatus.state === 'success' || commitStatus.statuses.length === 0) &&
    checkRuns.every((run) =>
      ['skipped', 'neutral', 'success'].includes(run.conclusion)
    )
  ) {
    return BranchStatus.green;
  }
  return BranchStatus.yellow;
}

async function getStatusCheck(
  branchName: string,
  useCache = true
): Promise<GhBranchStatus[]> {
  const branchCommit = git.getBranchCommit(branchName);

  const url = `repos/${config.repository}/commits/${branchCommit}/statuses`;

  return (await githubApi.getJson<GhBranchStatus[]>(url, { useCache })).body;
}

const githubToRenovateStatusMapping = {
  success: BranchStatus.green,
  error: BranchStatus.red,
  failure: BranchStatus.red,
  pending: BranchStatus.yellow,
};

export async function getBranchStatusCheck(
  branchName: string,
  context: string
): Promise<BranchStatus | null> {
  try {
    const res = await getStatusCheck(branchName);
    for (const check of res) {
      if (check.context === context) {
        return (
          githubToRenovateStatusMapping[check.state] || BranchStatus.yellow
        );
      }
    }
    return null;
  } catch (err) /* istanbul ignore next */ {
    if (err.statusCode === 404) {
      logger.debug('Commit not found when checking statuses');
      throw new Error(REPOSITORY_CHANGED);
    }
    throw err;
  }
}

export async function setBranchStatus({
  branchName,
  context,
  description,
  state,
  url: targetUrl,
}: BranchStatusConfig): Promise<void> {
  // istanbul ignore if
  if (config.parentRepo) {
    logger.debug('Cannot set branch status when in forking mode');
    return;
  }
  const existingStatus = await getBranchStatusCheck(branchName, context);
  if (existingStatus === state) {
    return;
  }
  logger.debug({ branch: branchName, context, state }, 'Setting branch status');
  let url: string;
  try {
    const branchCommit = git.getBranchCommit(branchName);
    url = `repos/${config.repository}/statuses/${branchCommit}`;
    const renovateToGitHubStateMapping = {
      green: 'success',
      yellow: 'pending',
      red: 'failure',
    };
    const options: any = {
      state: renovateToGitHubStateMapping[state],
      description,
      context,
    };
    if (targetUrl) {
      options.target_url = targetUrl;
    }
    await githubApi.postJson(url, { body: options });

    // update status cache
    await getStatus(branchName, false);
    await getStatusCheck(branchName, false);
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ err, url }, 'Caught error setting branch status - aborting');
    throw new Error(REPOSITORY_CHANGED);
  }
}

// Issue

/* istanbul ignore next */
async function getIssues(): Promise<Issue[]> {
  const result = await githubApi.queryRepoField<Issue>(
    getIssuesQuery,
    'issues',
    {
      variables: {
        owner: config.repositoryOwner,
        name: config.repositoryName,
        user: config.renovateUsername,
      },
    }
  );

  logger.debug(`Retrieved ${result.length} issues`);
  return result.map((issue) => ({
    ...issue,
    state: issue.state.toLowerCase(),
  }));
}

export async function getIssueList(): Promise<Issue[]> {
  // istanbul ignore if
  if (config.hasIssuesEnabled === false) {
    return [];
  }
  if (!config.issueList) {
    logger.debug('Retrieving issueList');
    config.issueList = await getIssues();
  }
  return config.issueList;
}

export async function getIssue(
  number: number,
  useCache = true
): Promise<Issue | null> {
  // istanbul ignore if
  if (config.hasIssuesEnabled === false) {
    return null;
  }
  try {
    const issueBody = (
      await githubApi.getJson<{ body: string }>(
        `repos/${config.parentRepo || config.repository}/issues/${number}`,
        { useCache }
      )
    ).body.body;
    return {
      number,
      body: issueBody,
    };
  } catch (err) /* istanbul ignore next */ {
    logger.debug({ err, number }, 'Error getting issue');
    return null;
  }
}

export async function findIssue(title: string): Promise<Issue | null> {
  logger.debug(`findIssue(${title})`);
  const [issue] = (await getIssueList()).filter(
    (i) => i.state === 'open' && i.title === title
  );
  if (!issue) {
    return null;
  }
  logger.debug(`Found issue ${issue.number}`);
  return getIssue(issue.number);
}

async function closeIssue(issueNumber: number): Promise<void> {
  logger.debug(`closeIssue(${issueNumber})`);
  await githubApi.patchJson(
    `repos/${config.parentRepo || config.repository}/issues/${issueNumber}`,
    {
      body: { state: 'closed' },
    }
  );
}

export async function ensureIssue({
  title,
  reuseTitle,
  body: rawBody,
  labels,
  once = false,
  shouldReOpen = true,
}: EnsureIssueConfig): Promise<EnsureIssueResult | null> {
  logger.debug(`ensureIssue(${title})`);
  // istanbul ignore if
  if (config.hasIssuesEnabled === false) {
    logger.info(
      'Cannot ensure issue because issues are disabled in this repository'
    );
    return null;
  }
  const body = sanitize(rawBody);
  try {
    const issueList = await getIssueList();
    let issues = issueList.filter((i) => i.title === title);
    if (!issues.length) {
      issues = issueList.filter((i) => i.title === reuseTitle);
      if (issues.length) {
        logger.debug({ reuseTitle, title }, 'Reusing issue title');
      }
    }
    if (issues.length) {
      let issue = issues.find((i) => i.state === 'open');
      if (!issue) {
        if (once) {
          logger.debug('Issue already closed - skipping recreation');
          return null;
        }
        if (shouldReOpen) {
          logger.debug('Reopening previously closed issue');
        }
        issue = issues[issues.length - 1];
      }
      for (const i of issues) {
        if (i.state === 'open' && i.number !== issue.number) {
          logger.warn(`Closing duplicate issue ${i.number}`);
          await closeIssue(i.number);
        }
      }
      const issueBody = (
        await githubApi.getJson<{ body: string }>(
          `repos/${config.parentRepo || config.repository}/issues/${
            issue.number
          }`
        )
      ).body.body;
      if (
        issue.title === title &&
        issueBody === body &&
        issue.state === 'open'
      ) {
        logger.debug('Issue is open and up to date - nothing to do');
        return null;
      }
      if (shouldReOpen) {
        logger.debug('Patching issue');
        const data: Record<string, unknown> = { body, state: 'open', title };
        if (labels) {
          data.labels = labels;
        }
        await githubApi.patchJson(
          `repos/${config.parentRepo || config.repository}/issues/${
            issue.number
          }`,
          {
            body: data,
          }
        );
        logger.debug('Issue updated');
        return 'updated';
      }
    }
    await githubApi.postJson(
      `repos/${config.parentRepo || config.repository}/issues`,
      {
        body: {
          title,
          body,
          labels: labels || [],
        },
      }
    );
    logger.info('Issue created');
    // reset issueList so that it will be fetched again as-needed
    delete config.issueList;
    return 'created';
  } catch (err) /* istanbul ignore next */ {
    if (err.body?.message?.startsWith('Issues are disabled for this repo')) {
      logger.debug(`Issues are disabled, so could not create issue: ${title}`);
    } else {
      logger.warn({ err }, 'Could not ensure issue');
    }
  }
  return null;
}

export async function ensureIssueClosing(title: string): Promise<void> {
  logger.trace(`ensureIssueClosing(${title})`);
  // istanbul ignore if
  if (config.hasIssuesEnabled === false) {
    logger.info(
      'Cannot ensure issue because issues are disabled in this repository'
    );
    return;
  }
  const issueList = await getIssueList();
  for (const issue of issueList) {
    if (issue.state === 'open' && issue.title === title) {
      await closeIssue(issue.number);
      logger.debug({ number: issue.number }, 'Issue closed');
    }
  }
}

export async function addAssignees(
  issueNo: number,
  assignees: string[]
): Promise<void> {
  logger.debug(`Adding assignees '${assignees.join(', ')}' to #${issueNo}`);
  const repository = config.parentRepo || config.repository;
  await githubApi.postJson(`repos/${repository}/issues/${issueNo}/assignees`, {
    body: {
      assignees,
    },
  });
}

export async function addReviewers(
  prNo: number,
  reviewers: string[]
): Promise<void> {
  logger.debug(`Adding reviewers '${reviewers.join(', ')}' to #${prNo}`);

  const userReviewers = reviewers.filter((e) => !e.startsWith('team:'));
  const teamReviewers = reviewers
    .filter((e) => e.startsWith('team:'))
    .map((e) => e.replace(regEx(/^team:/), '')); // TODO #12071
  try {
    await githubApi.postJson(
      `repos/${
        config.parentRepo || config.repository
      }/pulls/${prNo}/requested_reviewers`,
      {
        body: {
          reviewers: userReviewers,
          team_reviewers: teamReviewers,
        },
      }
    );
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err }, 'Failed to assign reviewer');
  }
}

async function addLabels(
  issueNo: number,
  labels: string[] | null
): Promise<void> {
  logger.debug(`Adding labels '${labels?.join(', ')}' to #${issueNo}`);
  const repository = config.parentRepo || config.repository;
  if (is.array(labels) && labels.length) {
    await githubApi.postJson(`repos/${repository}/issues/${issueNo}/labels`, {
      body: labels,
    });
  }
}

export async function deleteLabel(
  issueNo: number,
  label: string
): Promise<void> {
  logger.debug(`Deleting label ${label} from #${issueNo}`);
  const repository = config.parentRepo || config.repository;
  try {
    await githubApi.deleteJson(
      `repos/${repository}/issues/${issueNo}/labels/${label}`
    );
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err, issueNo, label }, 'Failed to delete label');
  }
}

async function addComment(issueNo: number, body: string): Promise<void> {
  // POST /repos/:owner/:repo/issues/:number/comments
  await githubApi.postJson(
    `repos/${
      config.parentRepo || config.repository
    }/issues/${issueNo}/comments`,
    {
      body: { body },
    }
  );
}

async function editComment(commentId: number, body: string): Promise<void> {
  // PATCH /repos/:owner/:repo/issues/comments/:id
  await githubApi.patchJson(
    `repos/${
      config.parentRepo || config.repository
    }/issues/comments/${commentId}`,
    {
      body: { body },
    }
  );
}

async function deleteComment(commentId: number): Promise<void> {
  // DELETE /repos/:owner/:repo/issues/comments/:id
  await githubApi.deleteJson(
    `repos/${
      config.parentRepo || config.repository
    }/issues/comments/${commentId}`
  );
}

async function getComments(issueNo: number): Promise<Comment[]> {
  const pr = (await getClosedPrs())[issueNo];
  if (pr) {
    logger.debug('Returning closed PR list comments');
    return pr.comments;
  }
  // GET /repos/:owner/:repo/issues/:number/comments
  logger.debug(`Getting comments for #${issueNo}`);
  const url = `repos/${
    config.parentRepo || config.repository
  }/issues/${issueNo}/comments?per_page=100`;
  try {
    const comments = (
      await githubApi.getJson<Comment[]>(url, {
        paginate: true,
      })
    ).body;
    logger.debug(`Found ${comments.length} comments`);
    return comments;
  } catch (err) /* istanbul ignore next */ {
    if (err.statusCode === 404) {
      logger.debug('404 response when retrieving comments');
      throw new ExternalHostError(err, PlatformId.Github);
    }
    throw err;
  }
}

export async function ensureComment({
  number,
  topic,
  content,
}: EnsureCommentConfig): Promise<boolean> {
  const sanitizedContent = sanitize(content);
  try {
    const comments = await getComments(number);
    let body: string;
    let commentId: number | null = null;
    let commentNeedsUpdating = false;
    if (topic) {
      logger.debug(`Ensuring comment "${topic}" in #${number}`);
      body = `### ${topic}\n\n${sanitizedContent}`;
      comments.forEach((comment) => {
        if (comment.body.startsWith(`### ${topic}\n\n`)) {
          commentId = comment.id;
          commentNeedsUpdating = comment.body !== body;
        }
      });
    } else {
      logger.debug(`Ensuring content-only comment in #${number}`);
      body = `${sanitizedContent}`;
      comments.forEach((comment) => {
        if (comment.body === body) {
          commentId = comment.id;
          commentNeedsUpdating = false;
        }
      });
    }
    if (!commentId) {
      await addComment(number, body);
      logger.info(
        { repository: config.repository, issueNo: number, topic },
        'Comment added'
      );
    } else if (commentNeedsUpdating) {
      await editComment(commentId, body);
      logger.debug(
        { repository: config.repository, issueNo: number },
        'Comment updated'
      );
    } else {
      logger.debug('Comment is already update-to-date');
    }
    return true;
  } catch (err) /* istanbul ignore next */ {
    if (err instanceof ExternalHostError) {
      throw err;
    }
    if (err.body?.message?.includes('is locked')) {
      logger.debug('Issue is locked - cannot add comment');
    } else {
      logger.warn({ err }, 'Error ensuring comment');
    }
    return false;
  }
}

export async function ensureCommentRemoval({
  number: issueNo,
  topic,
  content,
}: EnsureCommentRemovalConfig): Promise<void> {
  logger.trace(
    `Ensuring comment "${topic || content}" in #${issueNo} is removed`
  );
  const comments = await getComments(issueNo);
  let commentId: number | null = null;

  const byTopic = (comment: Comment): boolean =>
    comment.body.startsWith(`### ${topic}\n\n`);
  const byContent = (comment: Comment): boolean =>
    comment.body.trim() === content;

  if (topic) {
    commentId = comments.find(byTopic)?.id;
  } else if (content) {
    commentId = comments.find(byContent)?.id;
  }

  try {
    if (commentId) {
      logger.debug({ issueNo }, 'Removing comment');
      await deleteComment(commentId);
    }
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ err }, 'Error deleting comment');
  }
}

// Pull Request

async function tryPrAutomerge(
  prNumber: number,
  prNodeId: string,
  platformOptions: PlatformPrOptions
): Promise<void> {
  if (platformConfig.isGhe || !platformOptions?.usePlatformAutomerge) {
    return;
  }

  if (!config.autoMergeAllowed) {
    logger.debug(
      { prNumber },
      'GitHub-native automerge: not enabled in repo settings'
    );
    return;
  }

  try {
    const mergeMethod = config.mergeMethod?.toUpperCase() || 'MERGE';
    const variables = { pullRequestId: prNodeId, mergeMethod };
    const queryOptions = { variables };

    const { errors } = await githubApi.requestGraphql<GhAutomergeResponse>(
      enableAutoMergeMutation,
      queryOptions
    );

    if (errors) {
      logger.debug({ prNumber, errors }, 'GitHub-native automerge: fail');
      return;
    }

    logger.debug({ prNumber }, 'GitHub-native automerge: success');
  } catch (err) {
    logger.warn({ prNumber, err }, 'GitHub-native automerge: REST API error');
  }
}

// Creates PR and returns PR number
export async function createPr({
  sourceBranch,
  targetBranch,
  prTitle: title,
  prBody: rawBody,
  labels,
  draftPR = false,
  platformOptions,
}: CreatePRConfig): Promise<Pr> {
  const body = sanitize(rawBody);
  const base = targetBranch;
  // Include the repository owner to handle forkMode and regular mode
  const head = `${config.repository.split('/')[0]}:${sourceBranch}`;
  const options: any = {
    body: {
      title,
      head,
      base,
      body,
      draft: draftPR,
    },
  };
  // istanbul ignore if
  if (config.forkToken) {
    options.token = config.forkToken;
    options.body.maintainer_can_modify = true;
  }
  logger.debug({ title, head, base, draft: draftPR }, 'Creating PR');
  const pr = (
    await githubApi.postJson<GhRestPr>(
      `repos/${config.parentRepo || config.repository}/pulls`,
      options
    )
  ).body;
  logger.debug(
    { branch: sourceBranch, pr: pr.number, draft: draftPR },
    'PR created'
  );
  // istanbul ignore if
  if (config.prList) {
    config.prList.push(pr);
  }
  pr.displayNumber = `Pull Request #${pr.number}`;
  pr.sourceBranch = sourceBranch;
  pr.sourceRepo = pr.head.repo.full_name;
  await addLabels(pr.number, labels);
  await tryPrAutomerge(pr.number, pr.node_id, platformOptions);
  return pr;
}

export async function updatePr({
  number: prNo,
  prTitle: title,
  prBody: rawBody,
  state,
}: UpdatePrConfig): Promise<void> {
  logger.debug(`updatePr(${prNo}, ${title}, body)`);
  const body = sanitize(rawBody);
  const patchBody: any = { title };
  if (body) {
    patchBody.body = body;
  }
  if (state) {
    patchBody.state = state;
  }
  const options: any = {
    body: patchBody,
  };
  // istanbul ignore if
  if (config.forkToken) {
    options.token = config.forkToken;
  }
  try {
    await githubApi.patchJson(
      `repos/${config.parentRepo || config.repository}/pulls/${prNo}`,
      options
    );
    logger.debug({ pr: prNo }, 'PR updated');
  } catch (err) /* istanbul ignore next */ {
    if (err instanceof ExternalHostError) {
      throw err;
    }
    logger.warn({ err }, 'Error updating PR');
  }
}

export async function mergePr({
  branchName,
  id: prNo,
}: MergePRConfig): Promise<boolean> {
  logger.debug(`mergePr(${prNo}, ${branchName})`);
  // istanbul ignore if
  if (config.prReviewsRequired) {
    logger.debug(
      { branch: branchName, prNo },
      'Branch protection: Attempting to merge PR when PR reviews are enabled'
    );
    const repository = config.parentRepo || config.repository;
    const reviews = await githubApi.getJson<{ state: string }[]>(
      `repos/${repository}/pulls/${prNo}/reviews`
    );
    const isApproved = reviews.body.some(
      (review) => review.state === 'APPROVED'
    );
    if (!isApproved) {
      logger.debug(
        { branch: branchName, prNo },
        'Branch protection: Cannot automerge PR until there is an approving review'
      );
      return false;
    }
    logger.debug('Found approving reviews');
  }
  const url = `repos/${
    config.parentRepo || config.repository
  }/pulls/${prNo}/merge`;
  const options: any = {
    body: {} as { merge_method?: string },
  };
  // istanbul ignore if
  if (config.forkToken) {
    options.token = config.forkToken;
  }
  let automerged = false;
  let automergeResult: any;
  if (config.mergeMethod) {
    // This path is taken if we have auto-detected the allowed merge types from the repo
    options.body.merge_method = config.mergeMethod;
    try {
      logger.debug({ options, url }, `mergePr`);
      automergeResult = await githubApi.putJson(url, options);
      automerged = true;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 405) {
        // istanbul ignore next
        logger.debug(
          { response: err.response ? err.response.body : undefined },
          'GitHub blocking PR merge -- will keep trying'
        );
      } else {
        logger.warn({ err }, `Failed to ${config.mergeMethod} merge PR`);
        return false;
      }
    }
  }
  if (!automerged) {
    // We need to guess the merge method and try squash -> rebase -> merge
    options.body.merge_method = 'rebase';
    try {
      logger.debug({ options, url }, `mergePr`);
      automergeResult = await githubApi.putJson(url, options);
    } catch (err1) {
      logger.debug({ err: err1 }, `Failed to rebase merge PR`);
      try {
        options.body.merge_method = 'squash';
        logger.debug({ options, url }, `mergePr`);
        automergeResult = await githubApi.putJson(url, options);
      } catch (err2) {
        logger.debug({ err: err2 }, `Failed to merge squash PR`);
        try {
          options.body.merge_method = 'merge';
          logger.debug({ options, url }, `mergePr`);
          automergeResult = await githubApi.putJson(url, options);
        } catch (err3) {
          logger.debug({ err: err3 }, `Failed to merge commit PR`);
          logger.info({ pr: prNo }, 'All merge attempts failed');
          return false;
        }
      }
    }
  }
  logger.debug(
    { automergeResult: automergeResult.body, pr: prNo },
    'PR merged'
  );
  return true;
}

export function massageMarkdown(input: string): string {
  if (platformConfig.isGhe) {
    return smartTruncate(input, 60000);
  }
  const massagedInput = massageMarkdownLinks(input)
    // to be safe, replace all github.com links with renovatebot redirector
    .replace(
      regEx(/href="https?:\/\/github.com\//g),
      'href="https://togithub.com/'
    )
    .replace(regEx(/]\(https:\/\/github\.com\//g), '](https://togithub.com/')
    .replace(regEx(/]: https:\/\/github\.com\//g), ']: https://togithub.com/');
  return smartTruncate(massagedInput, 60000);
}

export async function getVulnerabilityAlerts(): Promise<VulnerabilityAlert[]> {
  let vulnerabilityAlerts: { node: VulnerabilityAlert }[];
  try {
    vulnerabilityAlerts = await githubApi.queryRepoField<{
      node: VulnerabilityAlert;
    }>(vulnerabilityAlertsQuery, 'vulnerabilityAlerts', {
      variables: { owner: config.repositoryOwner, name: config.repositoryName },
      paginate: false,
      acceptHeader: 'application/vnd.github.vixen-preview+json',
    });
  } catch (err) {
    logger.debug({ err }, 'Error retrieving vulnerability alerts');
    logger.warn(
      {
        url: 'https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts',
      },
      'Cannot access vulnerability alerts. Please ensure permissions have been granted.'
    );
  }
  let alerts: VulnerabilityAlert[] = [];
  try {
    if (vulnerabilityAlerts?.length) {
      alerts = vulnerabilityAlerts.map((edge) => edge.node);
      const shortAlerts: AggregatedVulnerabilities = {};
      if (alerts.length) {
        logger.trace({ alerts }, 'GitHub vulnerability details');
        for (const alert of alerts) {
          const {
            package: { name, ecosystem },
            vulnerableVersionRange,
            firstPatchedVersion,
          } = alert.securityVulnerability;
          const patch = firstPatchedVersion?.identifier;

          const key = `${ecosystem.toLowerCase()}/${name}`;
          const range = vulnerableVersionRange;
          const elem = shortAlerts[key] || {};
          elem[range] = patch || null;
          shortAlerts[key] = elem;
        }
        logger.debug({ alerts: shortAlerts }, 'GitHub vulnerability details');
      }
    } else {
      logger.debug('No vulnerability alerts found');
    }
  } catch (err) /* istanbul ignore next */ {
    logger.error({ err }, 'Error processing vulnerabity alerts');
  }
  return alerts;
}
