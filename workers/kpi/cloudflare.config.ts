export default {
  worker: {
    name: 'omochi-tune-kpi',
    compatibilityDate: '2026-11-26',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: './src/index.mjs',
    workersDev: true,
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 0.1 }
    },
    env: {
      DB: {
        type: 'd1',
        name: 'omochi-tune-kpi-db',
        id: 'faa01ca1-7e5f-4d21-95be-e8c7c59e738e'
      }
    }
  }
};
