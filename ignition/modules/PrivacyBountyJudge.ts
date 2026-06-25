import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploy PrivacyBountyJudge.
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/PrivacyBountyJudge.ts \
 *     --network <network> \
 *     --parameters '{"oracleAddress":"0x..."}'
 *
 * For local testing a MockOracle is deployed first.
 */

const PrivacyBountyJudgeModule = buildModule("PrivacyBountyJudgeModule", (m) => {
  const oracleAddressEnv = process.env.RITUAL_ORACLE_ADDRESS;
  const useMock = !oracleAddressEnv || oracleAddressEnv === "0x0000000000000000000000000000000000000000";

  let resolvedOracle;
  let mockOracle;

  if (useMock) {
    mockOracle = m.contract("MockOracle");
    resolvedOracle = mockOracle;
  } else {
    resolvedOracle = m.contractAt("IOracle", oracleAddressEnv as `0x${string}`);
  }

  const bountyJudge = m.contract("PrivacyBountyJudge", [resolvedOracle]);

  return { mockOracle, bountyJudge };
});

export default PrivacyBountyJudgeModule;
