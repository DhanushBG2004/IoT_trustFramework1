async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  const TrustLogger = await ethers.getContractFactory("TrustLogger");
  const trustLogger = await TrustLogger.deploy();
  await trustLogger.deployed();
  console.log("TrustLogger deployed to:", trustLogger.address);
}
main().catch(err => { console.error(err); process.exit(1); });
