/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  testTimeout: 10000,
  clearMocks: true,
  collectCoverageFrom: ["src/**/*.ts", "!src/__tests__/**"],
};
