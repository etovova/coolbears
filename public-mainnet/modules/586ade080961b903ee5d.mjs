import { createDefaultProgramRepository } from '/public-mainnet/modules/8d0fedd15532f04a6b88.mjs';

const defaultProgramRepository = () => ({
  install(umi) {
    umi.programs = createDefaultProgramRepository(umi);
  }
});

export { defaultProgramRepository };

