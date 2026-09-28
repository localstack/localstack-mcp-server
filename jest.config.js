module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/?(*.)+(spec|test).[jt]s?(x)"],
  // Live suites need a running emulator; they run only through
  // jest.azure-live.config.js (plan section 5.4; review F15).
  testPathIgnorePatterns: ["/node_modules/", "\\.live\\.test\\.ts$"],
  // The Azure runner tests spawn real processes; on a loaded machine the 5 s default
  // starved unrelated timing-based tests (seen in full-suite runs).
  testTimeout: 30000,
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.tests.json" }],
  },
};
