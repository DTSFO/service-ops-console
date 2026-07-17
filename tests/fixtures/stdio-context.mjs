export function createTestContext() {
  return {
    config: {
      stdioScopes: ["services:read"],
      privilegedOperations: false,
    },
    operations: {
      listServices: async () => ({ services: [{ id: "example-api" }] }),
      controlService: async () => ({ shouldNotRun: true }),
    },
  };
}
