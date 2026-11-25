# Security Specification — Circolo Hold'em Firestore

## 1. Data Invariants (Master Source of Truth)
1. **Default-Deny Safety Net**: Every unspecified path under `/databases/{database}/documents` is denied (`allow read, write: if false`).
2. **Verified Google Identity Only**: Every non-deny rule requires `request.auth != null && request.auth.token.email_verified == true`.
3. **ID Poisoning Guard**: Every single-document operation enforces `isValidId(docId)` (`<= 128` chars matching `^[a-zA-Z0-9_\-]+$`).
4. **Strict User Profile Isolation**: `/users/{userId}` stores zero PII (`email`, `phone`, `address` absent) and restricts `get`, `create`, and `update` exclusively to `request.auth.uid == userId`; `list` and `delete` are denied.
5. **Private Tournament Code Confidentiality**:
   - Plaintext `inviteCode` is strictly empty (`""`) on private `/tournaments/{tournId}` documents; only `inviteCodeHash` (salted SHA-256) is stored on the tournament document.
   - `/tournamentCodes/{code}` enforces `allow list: if false` so private codes cannot be scraped; direct `get` resolves only when a caller knows the exact code, and `create` requires `exists(/tournaments/$(tournId))` and `creatorId == request.auth.uid`.
6. **Tournament Lifecycle & Terminal Locking**:
   - Only the creator (`creatorId == request.auth.uid`) can create a tournament, initially in `status == "registering"` with `playerIds == [request.auth.uid]`.
   - `register` and `unregister` updates strictly limit `affectedKeys()` to `['players', 'playerIds', 'updatedAt']` while `status == "registering"`.
   - Once `status` reaches `'finished'` or `'cancelled'`, ALL subsequent updates are rejected.
7. **Spin & Go Matchmaking Integrity**:
   - `/spinQueues/{tierId}` restricts `tier` to `[100, 500, 1000, 2500, 5000]` and `list` evaluates `resource.data.tier`.
   - `/spinMatches/{userId}` can only be read or deleted by `userId` (`list` denied), and creation verifies via `exists()`/`get()` that `tableId` exists and both `userId` and `request.auth.uid` are participants in `tables/{tableId}.playerIds`.
8. **Table & Chat Master Gate**:
   - `/tables/{tableId}` restricts reads and gameplay mutations exclusively to `playerIds` (or participants of the parent MTT `tournamentId`), locks updates once `phase == 'TOURNAMENT_OVER'`, and enforces immutable `id`, `mode`, `tournamentId`, `buyIn`, `prizePool`, `blindSpeed`, and `createdAt`.
   - `/tables/{tableId}/chats/{msgId}` uses Master Gate validation against `/tables/{tableId}` (`exists` + `get` on create/get), enforces `senderId == request.auth.uid`, bounds message length (`<= 160`), and restricts `list` via `request.auth.uid in existing().tablePlayerIds` with zero `get()` calls inside `allow list`.
9. **Temporal Integrity & Bounded Strings/Arrays**:
   - Every `createdAt` / `updatedAt` field must equal `request.time` (`serverTimestamp()`).
   - Every `string` rule enforces a `.size()` bound and every `list` rule enforces `.size() <= MAX`.

## 2. The "Dirty Dozen" Payloads (Adversarial TDD Suite)
1. **Unverified / Anonymous Spoof (`users/{uid}`)**: Write with `email_verified: false` or `request.auth == null` -> `PERMISSION_DENIED`.
2. **Cross-User Wallet Tampering (`users/{victimUid}`)**: User A attempts to read or update `users/{userB}` balance -> `PERMISSION_DENIED`.
3. **Ghost Field Shadow Update (`tournaments/{tournId}`)**: Authenticated user includes `"isFeatured": true` or `"adminOverride": true` alongside valid tournament keys -> `PERMISSION_DENIED`.
4. **Identity Spoofing on Tournament Creation (`tournaments/{tournId}`)**: Attacker sets `creatorId` to another user's UID -> `PERMISSION_DENIED`.
5. **Private Tournament Code Scraping (`tournamentCodes`)**: Authenticated attacker executes a collection `list` query on `/tournamentCodes` -> `PERMISSION_DENIED`.
6. **Client Timestamp Forgery (`tournaments/{tournId}`)**: Attacker sends numeric/backdated `createdAt` instead of `request.time` -> `PERMISSION_DENIED`.
7. **ID Poisoning Attack (`tables/{1500_char_junk_id}`)**: Oversized or invalid-character document ID -> `PERMISSION_DENIED`.
8. **Terminal State Mutation (`tournaments/{finishedId}`)**: Participant tries to change `winnerName` or reopen `status` after `status == 'finished'` -> `PERMISSION_DENIED`.
9. **Table State Hijack (`tables/{tableId}`)**: Participant tries to mutate immutable `prizePool`, `buyIn`, or `mode` during a hand update -> `PERMISSION_DENIED`.
10. **Non-Participant Table Snooping (`tables/{privateTableId}`)**: Outsider not in `playerIds` attempts `get` or `update` on an active table -> `PERMISSION_DENIED`.
11. **Chat Impersonation (`tables/{tableId}/chats/{msgId}`)**: Table player sends chat with `senderId != request.auth.uid` or oversized `text` (> 160 chars) -> `PERMISSION_DENIED`.
12. **Orphaned / Spoofed SpinMatch (`spinMatches/{victimUid}`)**: Attacker tries to redirect a victim to an arbitrary `tableId` where the victim is not in `playerIds` -> `PERMISSION_DENIED`.
