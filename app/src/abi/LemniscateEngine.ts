export const LemniscateEngineAbi = [
  {
    "type": "constructor",
    "inputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "DEFAULT_ADMIN_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "GUARDIAN_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "KEEPER_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "UPGRADE_INTERFACE_VERSION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "accrue",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "accrueAll",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "buy",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "usdgIn",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minTokensOut",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "tokensOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "buyWithPermit",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "usdgIn",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minTokensOut",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "permitDeadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "v",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "r",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "s",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "tokensOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "currentCarryWad",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "carryWad",
        "type": "int256",
        "internalType": "int256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "currentNormFactor",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "normFactor",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "currentRegime",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum Regime"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "dailyCarryBps",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "carryBps",
        "type": "int256",
        "internalType": "int256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getConfig",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct MarketConfig",
        "components": [
          {
            "name": "stock",
            "type": "address",
            "internalType": "contract IStockToken"
          },
          {
            "name": "feed",
            "type": "address",
            "internalType": "contract IAggregatorV3"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "contract OptionToken"
          },
          {
            "name": "scale",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "openSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "offHoursSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "pausedSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "openBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "offHoursBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "impactBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxMarketExposureBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxTradeUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "minTradeUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "pausedSellCapPerBlockUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "offHoursCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "skewCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "minCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "maxCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "baseCarryMinWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "baseCarryMaxWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "maxAgeOpen",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxAgeOffHours",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "feed2",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "offHoursBuyMaxAge",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRoleAdmin",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getState",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct MarketState",
        "components": [
          {
            "name": "normFactor",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "lastAccrual",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "regime",
            "type": "uint8",
            "internalType": "enum Regime"
          },
          {
            "name": "buysPaused",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "baseCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "baseCarryUpdatedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "lastGoodIndex",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "lastGoodPrice",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "lastGoodAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "vaultShort",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "lastUtilBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "pausedSellBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "pausedSellUsed",
            "type": "uint128",
            "internalType": "uint128"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "globalBuysPaused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "grantRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "hasRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hedgeDelta",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "units",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "index",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "indexWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "initialize",
    "inputs": [
      {
        "name": "admin",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "usdg_",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "vault_",
        "type": "address",
        "internalType": "contract IWriterPool"
      },
      {
        "name": "marketHours_",
        "type": "address",
        "internalType": "contract IMarketHours"
      },
      {
        "name": "treasury_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "liability",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "liabilityWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "listMarket",
    "inputs": [
      {
        "name": "config",
        "type": "tuple",
        "internalType": "struct MarketConfig",
        "components": [
          {
            "name": "stock",
            "type": "address",
            "internalType": "contract IStockToken"
          },
          {
            "name": "feed",
            "type": "address",
            "internalType": "contract IAggregatorV3"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "contract OptionToken"
          },
          {
            "name": "scale",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "openSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "offHoursSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "pausedSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "openBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "offHoursBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "impactBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxMarketExposureBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxTradeUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "minTradeUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "pausedSellCapPerBlockUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "offHoursCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "skewCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "minCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "maxCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "baseCarryMinWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "baseCarryMaxWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "maxAgeOpen",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxAgeOffHours",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "feed2",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "offHoursBuyMaxAge",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "symbol",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "initialBaseCarryWad",
        "type": "int64",
        "internalType": "int64"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "marketCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "marketHours",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IMarketHours"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "marketIdOf",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxGlobalExposureBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "protocolFeeShareBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "proxiableUUID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteBuy",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "usdgIn",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "tokensOut",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxUsdgIn",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteSell",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "tokensIn",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "usdgOut",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "price",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "callerConfirmation",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sell",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "tokensIn",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minUsdgOut",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "usdgOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sequencerFeed",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IAggregatorV3"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setBaseCarry",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "wad",
        "type": "int64",
        "internalType": "int64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setBuysPaused",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "paused",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setGlobal",
    "inputs": [
      {
        "name": "maxGlobalExposureBps_",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "protocolFeeShareBps_",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "treasury_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "sequencerFeed_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setGlobalBuysPaused",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMarketConfig",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "config",
        "type": "tuple",
        "internalType": "struct MarketConfig",
        "components": [
          {
            "name": "stock",
            "type": "address",
            "internalType": "contract IStockToken"
          },
          {
            "name": "feed",
            "type": "address",
            "internalType": "contract IAggregatorV3"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "contract OptionToken"
          },
          {
            "name": "scale",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "feeBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "openSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "offHoursSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "pausedSpreadBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "openBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "offHoursBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "impactBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxMarketExposureBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxTradeUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "minTradeUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "pausedSellCapPerBlockUsdg",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "offHoursCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "skewCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "minCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "maxCarryWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "baseCarryMinWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "baseCarryMaxWad",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "maxAgeOpen",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "maxAgeOffHours",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "feed2",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "offHoursBuyMaxAge",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "spotPrice",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "spot",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "updatedAt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "valid",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tokenPrice",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "priceWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalLiability",
    "inputs": [],
    "outputs": [
      {
        "name": "liabilityWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "treasury",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "upgradeToAndCall",
    "inputs": [
      {
        "name": "newImplementation",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "usdg",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "valuation",
    "inputs": [],
    "outputs": [
      {
        "name": "totalLiabilityWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "marks",
        "type": "tuple[]",
        "internalType": "struct ValuationMark[]",
        "components": [
          {
            "name": "spot",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "liability",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "regime",
            "type": "uint8",
            "internalType": "enum Regime"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "vault",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IWriterPool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Accrued",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "normFactor",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "carryWad",
        "type": "int64",
        "indexed": false,
        "internalType": "int64"
      },
      {
        "name": "regime",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum Regime"
      },
      {
        "name": "index",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BaseCarryUpdated",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "wad",
        "type": "int64",
        "indexed": false,
        "internalType": "int64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Bought",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "buyer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "usdgIn",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "tokensOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "price",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "index",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "normFactor",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BuysPaused",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GlobalBuysPaused",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GlobalConfigUpdated",
    "inputs": [
      {
        "name": "maxGlobalExposureBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "protocolFeeShareBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "treasury",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "sequencerFeed",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Initialized",
    "inputs": [
      {
        "name": "version",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MarketConfigUpdated",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MarketListed",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "stock",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "feed",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "scale",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RegimeChanged",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "from",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum Regime"
      },
      {
        "name": "to",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum Regime"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleAdminChanged",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previousAdminRole",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "newAdminRole",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleGranted",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleRevoked",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Sold",
    "inputs": [
      {
        "name": "id",
        "type": "uint8",
        "indexed": true,
        "internalType": "uint8"
      },
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "tokensIn",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "usdgOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "fee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "price",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "index",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "normFactor",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Upgraded",
    "inputs": [
      {
        "name": "implementation",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccessControlBadConfirmation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AccessControlUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "neededRole",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "AddressEmptyCode",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "BuysPausedErr",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CarryChangeTooFast",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CarryOutOfBounds",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ERC1967InvalidImplementation",
    "inputs": [
      {
        "name": "implementation",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC1967NonPayable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Expired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FailedCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "GlobalCapExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientLiquidity",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidInitialization",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidMarketConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MarketCapExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MarketNotFound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotInitializing",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OracleInvalid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PausedSellCapExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RegimePaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "Slippage",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TradeTooLarge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TradeTooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UUPSUnauthorizedCallContext",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UUPSUnsupportedProxiableUUID",
    "inputs": [
      {
        "name": "slot",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
