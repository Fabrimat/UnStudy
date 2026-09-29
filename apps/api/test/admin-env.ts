// Import before anything that loads src/config: the model catalogue is parsed once at import time.
process.env.LLM_PROVIDERS = JSON.stringify([{ id: 'fake', baseUrl: 'fake', apiKeyEnv: 'ADMIN_SPEC_KEY' }]);
process.env.ADMIN_SPEC_KEY = 'sk-should-never-leak';
process.env.LLM_MODELS = JSON.stringify([
  { id: 'lab', label: 'Lab only', model: 'p/lab', multiplier: 1, adminOnly: true, temperature: null },
  { id: 'fast', label: 'Fast', model: 'p/fast', multiplier: 1, priceIn: 1, priceOut: 2 },
  { id: 'big', label: 'Big', model: 'p/big', multiplier: 2, priceIn: 10, priceOut: 20 },
]);
