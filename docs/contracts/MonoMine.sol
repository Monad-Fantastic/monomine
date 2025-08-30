// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// -----------------------------------------------------------------------
/// Minimal Ownable (no OZ)
/// -----------------------------------------------------------------------
abstract contract Ownable {
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    address public owner;
    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    constructor() { owner = msg.sender; emit OwnershipTransferred(address(0), msg.sender); }
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero addr");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

/// -----------------------------------------------------------------------
/// TMF interfaces (adjust if your ABIs differ)
/// -----------------------------------------------------------------------
interface IPassport {
    function fidOf(address user) external view returns (uint256);
}

/// EIP-2771-style trusted forwarder
interface IEntryForwarder {
    function isTrustedForwarder(address forwarder) external view returns (bool); // optional
}

/// RelayManager that enforces quotas/policies
interface IRelayManager {
    /// Should revert/return false if user not allowed right now (quota exceeded, etc.).
    /// `action` can be the function selector (msg.sig).
    function spend(address user, bytes4 action) external returns (bool);
}

/// -----------------------------------------------------------------------
/// ERC2771-like Context (no OZ)
/// -----------------------------------------------------------------------
abstract contract ERC2771Recipient {
    address public trustedForwarder;

    event TrustedForwarderChanged(address indexed previous, address indexed current);

    function _setTrustedForwarder(address fwd) internal {
        emit TrustedForwarderChanged(trustedForwarder, fwd);
        trustedForwarder = fwd;
    }

    function isTrustedForwarder(address forwarder) public view returns (bool) {
        return forwarder == trustedForwarder;
    }

    function _msgSender() internal view returns (address sender) {
        if (isTrustedForwarder(msg.sender) && msg.data.length >= 20) {
            // The last 20 bytes of calldata are the real sender for 2771
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    function _msgData() internal view returns (bytes calldata) {
        if (isTrustedForwarder(msg.sender) && msg.data.length >= 20) {
            return msg.data[:msg.data.length - 20];
        } else {
            return msg.data;
        }
    }
}

/// -----------------------------------------------------------------------
/// MonoMine — TMF-ready
/// -----------------------------------------------------------------------
contract MonoMine is Ownable, ERC2771Recipient {
    // --- External systems (editable) ---
    IPassport    public passport;          // TMF Passport
    IRelayManager public relayManager;     // TMF RelayManager (optional)

    // --- Tunables (editable) ---
    uint256 public cooldownSeconds;        // per-address submit cooldown
    uint256 public epochSeconds;           // "day" length
    bool    public paused;

    // --- Game state ---
    uint256 public day;     // epoch index
    bytes32 public seed;    // current epoch seed
    uint256 public rolledAt;

    struct Score {
        address player;
        uint256 fid;
        bytes32 bestHash;
        uint256 submittedAt;
        uint256 submits;
    }

    mapping(uint256 => Score) public bestOfDay;
    mapping(uint256 => mapping(address => uint256)) public lastSubmitAt;

    // --- Events ---
    event Rolled(uint256 indexed day, bytes32 seed);
    event Submitted(uint256 indexed day, address indexed player, uint256 fid, bytes32 h, uint256 at);
    event ParamsUpdated(address passport, address forwarder, address relay, uint256 cooldown, uint256 epoch, bool paused);

    constructor(address _passport, address _forwarder, address _relayManager) {
        passport = IPassport(_passport);
        _setTrustedForwarder(_forwarder);
        relayManager = IRelayManager(_relayManager);

        cooldownSeconds = 60;
        epochSeconds = 1 days;
        _roll();
    }

    // ---------- Admin ----------
    function setPassport(address _passport) external onlyOwner {
        passport = IPassport(_passport);
        _emitParams();
    }
    function setTrustedForwarder(address fwd) external onlyOwner {
        _setTrustedForwarder(fwd);
        _emitParams();
    }
    function setRelayManager(address r) external onlyOwner {
        relayManager = IRelayManager(r);
        _emitParams();
    }
    function setCooldown(uint256 s) external onlyOwner {
        require(s <= 3600, "cooldown too large");
        cooldownSeconds = s;
        _emitParams();
    }
    function setEpochSeconds(uint256 s) external onlyOwner {
        require(s >= 60 && s <= 2 days, "epoch out of range");
        epochSeconds = s;
        _emitParams();
    }
    function setPaused(bool p) external onlyOwner {
        paused = p;
        _emitParams();
    }
    function forceRoll() external onlyOwner { _roll(); }

    function _emitParams() internal {
        emit ParamsUpdated(address(passport), trustedForwarder, address(relayManager), cooldownSeconds, epochSeconds, paused);
    }

    // ---------- Core ----------
    function _now() internal view returns (uint256) { return block.timestamp; }
    function _today() internal view returns (uint256) { return _now() / epochSeconds; }

    function _roll() internal {
        day = _today();
        seed = keccak256(abi.encodePacked(blockhash(block.number - 1), address(this), day));
        rolledAt = _now();
        emit Rolled(day, seed);
    }

    function rollIfNeeded() external {
        if (_today() > day) _roll();
    }

    /// Mine off-chain: h = keccak256(seed || fid || nonce). Submit nonce here.
    /// Works with EOAs *and* via TMF EntryForwarder (gasless).
    function submit(bytes32 nonce) external {
        require(!paused, "paused");
        if (_today() > day) _roll();

        address sender = _msgSender(); // honors EIP-2771
        uint256 fid = passport.fidOf(sender);
        require(fid != 0, "Passport required");

        // TMF RelayManager check (if configured)
        if (address(relayManager) != address(0)) {
            bool ok = relayManager.spend(sender, msg.sig);
            require(ok, "relay quota");
        }

        uint256 ls = lastSubmitAt[day][sender];
        require(_now() >= ls + cooldownSeconds, "cooldown");
        lastSubmitAt[day][sender] = _now();

        bytes32 h = keccak256(abi.encodePacked(seed, fid, nonce));
        Score storage cur = bestOfDay[day];

        if (
            cur.player == address(0) ||
            uint256(h) < uint256(cur.bestHash) ||
            (h == cur.bestHash && _now() < cur.submittedAt)
        ) {
            bestOfDay[day] = Score({
                player: sender,
                fid: fid,
                bestHash: h,
                submittedAt: _now(),
                submits: cur.submits + 1
            });
        } else {
            cur.submits += 1;
        }

        emit Submitted(day, sender, fid, h, _now());
    }

    // ---------- Views ----------
    function getLeaderboard(uint256 dayIndex)
        external view
        returns (address player, uint256 fid, bytes32 bestHash, uint256 submittedAt, uint256 submits)
    {
        Score memory s = bestOfDay[dayIndex];
        return (s.player, s.fid, s.bestHash, s.submittedAt, s.submits);
    }
}
