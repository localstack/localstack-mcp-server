// Live Azure suites (plan section 5.4; review F15, R02). They need a running LocalStack
// Azure emulator, so `yarn test` never runs them (jest.config.js ignores *.live.test.ts).
//
//   AZURE_LIVE=1 npx jest -c jest.azure-live.config.js --selectProjects matrix-subset egress
//
// Jest projects select files; the matrix and samples subsets are chosen by the env var
// each project's setup file sets, and every live file skips itself unless AZURE_LIVE=1.
const shared = {
  preset: "ts-jest",
  testEnvironment: "node",
  transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.tests.json" }] },
  // Closes the egress guard after each file, so Jest exits.
  setupFilesAfterEnv: ["<rootDir>/tests/azure/live/teardown.ts"],
};

module.exports = {
  // A live az call can take minutes (storage accounts on a busy emulator: ~100 s). Jest
  // reads testTimeout from the top level only; inside projects[] it is ignored and every
  // test would get the 5 s default.
  testTimeout: 900_000,
  projects: [
    {
      ...shared,
      displayName: "matrix-subset",
      testMatch: ["<rootDir>/tests/azure/matrix.live.test.ts"],
      setupFiles: ["<rootDir>/tests/azure/live/setup-matrix-pr.js"],
    },
    {
      ...shared,
      displayName: "matrix-full",
      testMatch: ["<rootDir>/tests/azure/matrix.live.test.ts"],
      setupFiles: ["<rootDir>/tests/azure/live/setup-matrix-full.js"],
    },
    {
      ...shared,
      displayName: "egress",
      testMatch: [
        "<rootDir>/tests/azure/egress.live.test.ts",
        "<rootDir>/tests/azure/home-guard.live.test.ts",
      ],
    },
    {
      ...shared,
      displayName: "samples-subset",
      testMatch: ["<rootDir>/tests/azure/samples-replay.live.test.ts"],
      setupFiles: ["<rootDir>/tests/azure/live/setup-samples-pr.js"],
    },
    {
      ...shared,
      displayName: "samples-all",
      testMatch: ["<rootDir>/tests/azure/samples-replay.live.test.ts"],
      setupFiles: ["<rootDir>/tests/azure/live/setup-samples-all.js"],
    },
    {
      ...shared,
      displayName: "drift",
      testMatch: ["<rootDir>/tests/azure/drift/*.live.test.ts"],
    },
  ],
};
