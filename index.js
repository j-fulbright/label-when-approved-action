import { info, setOutput, getInput, warning, setFailed } from '@actions/core';
import { getOctokit, context as _context } from '@actions/github';

function getRequiredEnv(key) {
  const value = process.env[key];
  if (value === undefined) {
    const message = `${key} was not defined.`;
    throw new Error(message);
  }
  return value;
}

function verboseOutput(name, value) {
  info(`Setting output: ${name}: ${value}`);
  setOutput(name, value);
}

async function setLabel(octokit, owner, repo, pullRequestNumber, label) {
  info(`Setting label "${label}"`);
  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
    owner,
    repo,
    issue_number: pullRequestNumber,
    labels: [label]
  });
}

async function addComment(octokit, owner, repo, pullRequestNumber, comment) {
  info(`Adding comment "${comment}"`);
  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner,
    repo,
    issue_number: pullRequestNumber,
    body: comment
  });
}

async function removeLabel(octokit, owner, repo, pullRequestNumber, label) {
  info(`Removing label "${label}"`);
  await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
    owner,
    repo,
    issue_number: pullRequestNumber,
    name: label
  });
}

async function processReviews(reviews, committers, requireCommittersApproval, numOfApprovals) {
  const approved = [];
  const changesRequested = [];

  let isApproved = false;
  const reviewStates = {};
  for (const review of reviews) {
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
      if (requireCommittersApproval && committers.includes(review.user.login)) {
        reviewStates[review.user.login] = review.state;
      } else if (!requireCommittersApproval) {
        reviewStates[review.user.login] = review.state;
      }
    }
  }

  info('Reviews:');
  for (const user in reviewStates) {
    info(`\t${user}: ${reviewStates[user].toLowerCase()}`);
  }

  for (const user in reviewStates) {
    if (reviewStates[user] === 'APPROVED') {
      approved.push(user);
    } else if (reviewStates[user] === 'CHANGES_REQUESTED') {
      changesRequested.push(user);
    }
  }

  // Did we get enough reviews?
  if (approved.length >= numOfApprovals) {
    isApproved = true;
  }

  // Are there changes requested?
  if (changesRequested.length > 0) {
    isApproved = false;
  }

  // Are we good to go?
  return isApproved;
}

async function getReviews(octokit, owner, repo, pullRequestNumber, requireCommittersApproval) {
  const { data: reviews } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner,
    repo,
    pull_number: pullRequestNumber
  });
  const reviewers = reviews && reviews.length > 0 ? reviews.map((review) => review.user.login) : [];
  const reviewersAlreadyChecked = [];
  const committers = [];

  if (requireCommittersApproval) {
    info(`\nChecking reviewers permissions`);
    for (const reviewer of reviewers) {
      if (!reviewersAlreadyChecked.includes(reviewer)) {
        const r = await octokit.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
          owner,
          repo,
          username: reviewer
        });

        if (r.data.permission === 'admin' || r.data.permission === 'write') {
          committers.push(reviewer);
        }
        info(`\t${reviewer}: ${r.data.permission}`);
        reviewersAlreadyChecked.push(reviewer);
      }
    }
  }

  return { reviews, committers };
}

async function run() {
  const token = getInput('token', { required: true });
  const userLabel = getInput('label') || 'not set';
  const requireCommittersApproval = getInput('require_committers_approval') === 'true';
  const removeLabelWhenApprovalMissing = getInput('remove_label_when_approval_missing') === 'true';
  const comment = getInput('comment') || '';
  const pullRequestNumberInput = getInput('pullRequestNumber') || 'not set';
  const numOfApprovals = parseInt(getInput('numOfApprovals') || 1);

  const octokit = getOctokit(token);
  const context = _context;
  const repository = getRequiredEnv('GITHUB_REPOSITORY');
  const eventName = getRequiredEnv('GITHUB_EVENT_NAME');
  const [owner, repo] = repository.split('/');

  let pullRequestNumber;

  //
  try {
    info(
      `\n############### Set Label When Approved Begin ##################\n` +
        `label: "${userLabel}"\n` +
        `requireCommittersApproval: ${requireCommittersApproval}\n` +
        `comment: ${comment}\n` +
        `pullRequestNumber: ${pullRequestNumberInput}\n` +
        `numOfApprovals: ${numOfApprovals}\n`
    );

    // Workflow event setup
    if (eventName === 'pull_request_review') {
      pullRequestNumber = context.payload.pull_request ? context.payload.pull_request.number : undefined;
      if (pullRequestNumber === undefined) {
        throw Error('Could not find PR number from context, exiting');
      }
    } else if (eventName === 'workflow_run') {
      if (pullRequestNumberInput === 'not set') {
        warning(
          `If action is triggered by "workflow_run" then input "pullRequestNumber" is required.\n` +
            `It might be missing because the pull request might have been already merged or a fixup pushed to` +
            `the PR branch. None of the outputs will be set as we cannot find the right PR.`
        );
        return;
      } else {
        pullRequestNumber = parseInt(pullRequestNumberInput);
      }
    } else {
      throw Error(
        `This action is only useful in "pull_request_review" or "workflow_run" triggered runs and you used it in "${eventName}"`
      );
    }

    // Get the PR
    const { data: pullRequest } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: pullRequestNumber
    });

    // Get the labels
    info('Grabbing labels');
    const labelNames = pullRequest.labels.map((label) => label.name);

    // Get the reviews
    info('Grabbing reviews');
    const { reviews, committers } = await getReviews(
      octokit,
      owner,
      repo,
      pullRequest.number,
      requireCommittersApproval
    );

    // Check if the PR is approved
    const isApproved = await processReviews(reviews, committers, requireCommittersApproval, numOfApprovals);

    // Add or remove the label
    let shouldLabelBeSet = false;
    let shouldLabelBeRemoved = false;
    if (userLabel !== 'not set') {
      shouldLabelBeSet = isApproved && !labelNames.includes(userLabel);
      shouldLabelBeRemoved = !isApproved && labelNames.includes(userLabel) && removeLabelWhenApprovalMissing;

      if (shouldLabelBeSet) {
        await setLabel(octokit, owner, repo, pullRequest.number, userLabel);
        if (comment !== '') {
          await addComment(octokit, owner, repo, pullRequest.number, comment);
        }
      } else if (shouldLabelBeRemoved) {
        await removeLabel(octokit, owner, repo, pullRequest.number, userLabel);
      }
    }

    // Set outputs
    verboseOutput('isApproved', String(isApproved));
    verboseOutput('shouldLabelBeSet', String(shouldLabelBeSet));
    verboseOutput('shouldLabelBeRemoved', String(shouldLabelBeRemoved));
  } catch (error) {
    setFailed(error.message);
  }
}

run()
  .then(() => info('\n############### Set Label When Approved End ##################\n'))
  .catch((e) => setFailed(e.message));
