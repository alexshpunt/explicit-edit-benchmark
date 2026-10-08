/** A closed-to-open transition hands a PR over to manual review permanently. */
export function wasPullRequestReopened(discussion) {
  let closed = false;
  for (const event of discussion.events) {
    if (event.type !== "status-change") continue;
    if (event.data?.status === "closed") closed = true;
    if (closed && event.data?.status === "open") return true;
  }
  return false;
}

/** Keep only PRs that have never been reopened, before automatic acceptance starts. */
export async function automaticPullRequests(repository, discussions, fetchImpl = fetch) {
  const automatic = [];
  for (const discussion of discussions) {
    const response = await fetchImpl(
      `https://huggingface.co/api/datasets/${repository}/discussions/${discussion.num}`,
    );
    if (!response.ok) throw Error(`Hugging Face candidate lookup failed (${response.status})`);
    if (!wasPullRequestReopened(await response.json())) automatic.push(discussion);
  }
  return automatic;
}
