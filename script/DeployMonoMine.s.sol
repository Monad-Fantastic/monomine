// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/MonoMine.sol";

contract DeployMonoMine is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address passport = vm.envAddress("PASSPORT_ADDRESS");
        address forwarder = vm.envAddress("FORWARDER_ADDRESS");
        address relayMgr = vm.envAddress("RELAY_MANAGER_ADDRESS");

        vm.startBroadcast(pk);
        MonoMine mono = new MonoMine(passport, forwarder, relayMgr);
        vm.stopBroadcast();

        console2.log("MonoMine deployed:", address(mono));
        console2.log("Passport:", passport);
        console2.log("Forwarder:", forwarder);
        console2.log("RelayMgr:", relayMgr);
    }
}
