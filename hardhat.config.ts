import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ignition-ethers";
import * as dotenv from "dotenv";

dotenv.config();

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY ?? "";
const REPORT_GAS = process.env.REPORT_GAS === "true";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "paris",
      // viaIR habilitado na Fase 5 parte 1/2: o CommunityGovernor (Governor +
      // GovernorSettings + GovernorCountingSimple + GovernorVotes +
      // GovernorVotesQuorumFraction + GovernorTimelockControl) estoura o limite
      // de 24.576 bytes (EIP-170 / Spurious Dragon) com o pipeline classico
      // (bytecode ~29.2KB @ runs=200). O pipeline via IR reduz o mesmo contrato
      // para ~15.3KB, caindo bem abaixo do limite. Efeito colateral aceitavel:
      // os outros contratos do projeto recompilam via IR tambem, com otimizacao
      // geralmente igual ou melhor — sem alteracao observavel em testes/gas.
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY,
    },
  },
  gasReporter: {
    enabled: REPORT_GAS,
    currency: "USD",
    coinmarketcap: COINMARKETCAP_API_KEY,
    excludeContracts: [],
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 40000,
  },
};

export default config;
