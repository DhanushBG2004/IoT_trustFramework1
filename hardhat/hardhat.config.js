require("@nomiclabs/hardhat-ethers");
require('dotenv').config();

module.exports = {
  solidity: "0.8.20",
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL,    // Alchemy/Infura
      accounts: [ process.env.DEPLOYER_PRIVATE_KEY ].filter(Boolean)
    },
    hardhat: {}
  }
};
