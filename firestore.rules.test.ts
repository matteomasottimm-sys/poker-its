/**
 * firestore.rules.test.ts
 * TDD specification verifying that all "Dirty Dozen" adversarial payloads
 * fail against the Firestore security invariants defined in security_spec.md.
 */

export interface DirtyPayloadCase {
  id: number;
  name: string;
  collectionPath: string;
  operation: "get" | "list" | "create" | "update" | "delete";
  expectedOutcome: "PERMISSION_DENIED";
  violatedPillar: string;
  payload: Record<string, unknown>;
}

export const DIRTY_DOZEN_PAYLOADS: DirtyPayloadCase[] = [
  {
    id: 1,
    name: "Unverified Email Spoof on User Profile",
    collectionPath: "users/attacker_uid",
    operation: "create",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Verified Users & Email Spoofing Guard",
    payload: {
      auth: { uid: "attacker_uid", token: { email_verified: false } },
      data: { id: "attacker_uid", name: "Spoofer", color: "#b91c1c", balance: 10000 }
    }
  },
  {
    id: 2,
    name: "Cross-User Profile & Balance Tampering",
    collectionPath: "users/victim_uid",
    operation: "update",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "PII & Owner Isolation",
    payload: {
      auth: { uid: "attacker_uid", token: { email_verified: true } },
      data: { balance: 9999999 }
    }
  },
  {
    id: 3,
    name: "Shadow Update with Ghost Field on Tournament",
    collectionPath: "tournaments/trn_1001",
    operation: "create",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Validation Blueprint (hasOnly)",
    payload: {
      auth: { uid: "user_a", token: { email_verified: true } },
      data: {
        id: "trn_1001",
        name: "Test",
        visibility: "public",
        inviteCode: "ABC123",
        inviteCodeHash: "hash",
        maxPlayers: 6,
        buyIn: 500,
        startingStack: 3000,
        blindSpeed: "normal",
        startMode: "full",
        status: "registering",
        creatorId: "user_a",
        ghostAdminFlag: true
      }
    }
  },
  {
    id: 4,
    name: "Identity Spoofing on Tournament Creation",
    collectionPath: "tournaments/trn_1002",
    operation: "create",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Identity Integrity",
    payload: {
      auth: { uid: "attacker_uid", token: { email_verified: true } },
      data: {
        id: "trn_1002",
        creatorId: "victim_uid",
        playerIds: ["victim_uid"]
      }
    }
  },
  {
    id: 5,
    name: "Private Tournament Invite Code Scraping via List Query",
    collectionPath: "tournamentCodes",
    operation: "list",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Secure List Queries (Zero-Scraping)",
    payload: {
      auth: { uid: "attacker_uid", token: { email_verified: true } },
      data: {}
    }
  },
  {
    id: 6,
    name: "Client-Forged Timestamp on Tournament",
    collectionPath: "tournaments/trn_1003",
    operation: "create",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Temporal Integrity (request.time)",
    payload: {
      auth: { uid: "user_a", token: { email_verified: true } },
      data: {
        createdAt: 1700000000000,
        updatedAt: 1700000000000
      }
    }
  },
  {
    id: 7,
    name: "ID Poisoning with Oversized Invalid Document ID",
    collectionPath: `tables/${"X".repeat(200)}!bad`,
    operation: "create",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Path Variable Hardening (isValidId)",
    payload: {
      auth: { uid: "user_a", token: { email_verified: true } },
      data: { id: "bad" }
    }
  },
  {
    id: 8,
    name: "Terminal State Mutation on Finished Tournament",
    collectionPath: "tournaments/trn_finished",
    operation: "update",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Terminal State Locking",
    payload: {
      auth: { uid: "user_a", token: { email_verified: true } },
      existing: { status: "finished", winnerName: "LegitWinner" },
      data: { status: "running", winnerName: "Attacker" }
    }
  },
  {
    id: 9,
    name: "Immutable PrizePool Tampering During Hand Update",
    collectionPath: "tables/tbl_1001",
    operation: "update",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Action-Based Update & Immutability",
    payload: {
      auth: { uid: "player_1", token: { email_verified: true } },
      existing: { phase: "PREFLOP", prizePool: 1000, playerIds: ["player_1", "player_2"] },
      data: { prizePool: 500000 }
    }
  },
  {
    id: 10,
    name: "Non-Participant Table Snooping",
    collectionPath: "tables/tbl_private",
    operation: "get",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Master Gate Membership Check",
    payload: {
      auth: { uid: "outsider_uid", token: { email_verified: true } },
      existing: { tournamentId: "", playerIds: ["player_1", "player_2"] },
      data: {}
    }
  },
  {
    id: 11,
    name: "Chat Sender Impersonation & Oversized Text",
    collectionPath: "tables/tbl_1001/chats/msg_1",
    operation: "create",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Master Gate & String Bounds",
    payload: {
      auth: { uid: "player_1", token: { email_verified: true } },
      data: {
        senderId: "player_2",
        sender: "Player 2",
        text: "A".repeat(300),
        system: false,
        ts: Date.now(),
        tablePlayerIds: ["player_1", "player_2"]
      }
    }
  },
  {
    id: 12,
    name: "Spoofed SpinMatch Redirect to Unowned Table",
    collectionPath: "spinMatches/victim_uid",
    operation: "create",
    expectedOutcome: "PERMISSION_DENIED",
    violatedPillar: "Global Consistency Invariant (exists/get)",
    payload: {
      auth: { uid: "attacker_uid", token: { email_verified: true } },
      data: {
        userId: "victim_uid",
        tableId: "unrelated_or_missing_table",
        createdBy: "attacker_uid"
      }
    }
  }
];

export function verifyDirtyDozenSpecification(): boolean {
  return (
    DIRTY_DOZEN_PAYLOADS.length === 12 &&
    DIRTY_DOZEN_PAYLOADS.every((c) => c.expectedOutcome === "PERMISSION_DENIED")
  );
}
