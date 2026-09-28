import type { APIRoute } from "astro";
import { ownerToken } from "../../lib/owner";
import { AlreadyWaitingError, joinWaitlist, listRooms } from "../../lib/db";
import { SLOTS, isBookableDate } from "../../lib/slots";

// The write half of the waitlist: only reachable for a slot that's already
// taken (the grid never renders this form otherwise), so the same
// roomId/date/slot validation `bookings.ts` does on a fresh booking applies
// here too — a hand-built request gets the same friendly redirect, not a
// raw foreign-key 500.
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const roomId = Number(form.get("roomId"));
  const date = String(form.get("date") ?? "");
  const slot = String(form.get("slot") ?? "");
  const wantedBy = String(form.get("wantedBy") ?? "")
    .trim()
    .slice(0, 80);

  const validRoomIds = new Set(listRooms().map((room) => room.id));
  if (
    !roomId ||
    !date ||
    !slot ||
    !wantedBy ||
    !validRoomIds.has(roomId) ||
    !(SLOTS as readonly string[]).includes(slot)
  ) {
    return redirect("/?error=missing", 303);
  }

  if (!isBookableDate(date)) {
    return redirect("/?error=date", 303);
  }

  const token = ownerToken(cookies);

  try {
    joinWaitlist({ roomId, date, slot, wantedBy, ownerToken: token });
  } catch (error) {
    if (error instanceof AlreadyWaitingError) {
      return redirect(`/?date=${date}&error=waiting`, 303);
    }
    throw error;
  }

  return redirect(`/?date=${date}`, 303);
};
