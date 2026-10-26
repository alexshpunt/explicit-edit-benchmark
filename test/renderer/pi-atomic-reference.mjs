// Keep existing deterministic runner fixtures on the native Bash editing path.
// There is no HTTP callback that can edit the candidate from the controller.
export { independentPiFactory as scriptedPiFactory } from "./pi-independent-reference.mjs";
