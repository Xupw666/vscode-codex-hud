const AUTO_LAUNCH_SUPPRESSION_MS = 4000;

function shouldAutoLaunch({ visible, launchConsumedForCurrentReveal, now, activatedAt }) {
  if (!visible || launchConsumedForCurrentReveal) {
    return false;
  }

  return now - activatedAt >= AUTO_LAUNCH_SUPPRESSION_MS;
}

function formatLaunchErrorMessage(error) {
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Unknown error";
}

module.exports = {
  AUTO_LAUNCH_SUPPRESSION_MS,
  shouldAutoLaunch,
  formatLaunchErrorMessage
};
