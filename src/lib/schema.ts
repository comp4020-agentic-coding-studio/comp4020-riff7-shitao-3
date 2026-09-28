import { sql } from "drizzle-orm";
import { int, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// The schema is the ground truth for the database. To change it: edit here,
// run `pnpm db:generate` to turn the diff into a migration under drizzle/,
// and commit both — the migration applies automatically when the server
// boots (see src/lib/db.ts). Never edit the database by hand: state on the
// deployed volume outlives every deploy, and the migration trail is what
// keeps old state and new code compatible.
export const rooms = sqliteTable("rooms", {
  id: int().primaryKey({ autoIncrement: true }),
  name: text().notNull().unique(),
});

export const bookings = sqliteTable(
  "bookings",
  {
    id: int().primaryKey({ autoIncrement: true }),
    roomId: int("room_id")
      .notNull()
      .references(() => rooms.id),
    date: text().notNull(),
    slot: text().notNull(),
    bookedBy: text("booked_by").notNull(),
    // Not an account — a random value set in a cookie the first time a
    // browser books anything, so cancellation can be gated to "whoever holds
    // the token this booking was made with" without asking anyone to sign in.
    // It doesn't vouch for the typed name; it only answers "did this browser
    // make this booking." The empty-string default only matters for rows
    // already on the volume from before this column existed — it can never
    // match a real cookie value, so old bookings are simply uncancellable,
    // which is the safe default (nobody gets to claim ownership of a
    // booking they didn't actually make).
    ownerToken: text("owner_token").notNull().default(""),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  // The constraint that makes a double-booking impossible, not just
  // unlikely — the one thing the real library booking page doesn't do.
  (table) => [unique().on(table.roomId, table.date, table.slot)],
);

// A slot that's already taken can still take a name here instead of turning
// someone away — the moment the booking holding that slot is cancelled, the
// oldest waiting name is promoted straight into a real booking, over the
// same SSE stream. `createdAt` orders that promotion FIFO; the unique
// constraint stops one browser piling onto the same slot's waitlist twice.
export const waitlist = sqliteTable(
  "waitlist",
  {
    id: int().primaryKey({ autoIncrement: true }),
    roomId: int("room_id")
      .notNull()
      .references(() => rooms.id),
    date: text().notNull(),
    slot: text().notNull(),
    wantedBy: text("wanted_by").notNull(),
    ownerToken: text("owner_token").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [unique().on(table.roomId, table.date, table.slot, table.ownerToken)],
);

export type Room = typeof rooms.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type WaitlistEntry = typeof waitlist.$inferSelect;
