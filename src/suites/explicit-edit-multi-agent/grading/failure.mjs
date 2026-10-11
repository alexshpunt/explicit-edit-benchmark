/** An editing failure is different from a verifier infrastructure failure. */
export class GradeFailure extends Error {
  constructor(category, message, options) {
    super(message, options);
    this.category = category;
  }
}
