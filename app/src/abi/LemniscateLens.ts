export const LemniscateLensAbi = [
  {
    "type": "function",
    "name": "account",
    "inputs": [
      {
        "name": "engine",
        "type": "address",
        "internalType": "contract ILemniscateEngine"
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "result",
        "type": "tuple",
        "internalType": "struct AccountView",
        "components": [
          {
            "name": "user",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "usdgBalance",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "usdgAllowanceEngine",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "usdgAllowanceVault",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "powerBalances",
            "type": "uint256[]",
            "internalType": "uint256[]"
          },
          {
            "name": "writerPoolShares",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "writerPoolValue",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "unlockTime",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "isDepositor",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "markets",
    "inputs": [
      {
        "name": "engine",
        "type": "address",
        "internalType": "contract ILemniscateEngine"
      }
    ],
    "outputs": [
      {
        "name": "result",
        "type": "tuple[]",
        "internalType": "struct MarketView[]",
        "components": [
          {
            "name": "id",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "stock",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "symbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "scale",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "regime",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "buysPaused",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "spot",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "spotUpdatedAt",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "index",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "normFactor",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "price",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "carryWad",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "vaultShort",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "liability",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "capacityUsdg",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "hedgeUnits",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "hedgeTarget",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "bidPrice1",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "askPrice1",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "multiplier",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pendingMultiplier",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "multiplierEffectiveAt",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "oraclePaused",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "vault",
    "inputs": [
      {
        "name": "engine",
        "type": "address",
        "internalType": "contract ILemniscateEngine"
      }
    ],
    "outputs": [
      {
        "name": "result",
        "type": "tuple",
        "internalType": "struct VaultView",
        "components": [
          {
            "name": "nav",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "totalAssets",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalSupply",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "navPerShare",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "usdgBalance",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalLiability",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxGlobalExposureBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "publicDeposits",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  }
] as const;
