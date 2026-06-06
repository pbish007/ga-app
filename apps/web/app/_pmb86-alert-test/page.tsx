// PMB-86 ONLY — deliberate TypeScript error to verify that a failed Vercel
// preview build emails the project owner. This file lives on the
// `pmb-86-test-vercel-failure-alert` branch and is NOT intended to be merged.
// The branch + draft PR are closed after the email arrives.

export default function PMB86AlertTest() {
  const intentionalTypeError: number = "PMB-86: this is a deliberate type error";
  return <div>{intentionalTypeError}</div>;
}
