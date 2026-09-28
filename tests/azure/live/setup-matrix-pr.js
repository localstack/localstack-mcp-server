// Jest setupFiles entry of jest.azure-live.config.js: selects the pr subset.
process.env.AZURE_MATRIX = process.env.AZURE_MATRIX || "pr";
