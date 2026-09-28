import type { APIRoute } from "astro";
import { cancelBooking, promoteWaitlist } from "../../../../lib/db";
import { bus } from "../../../../lib/events";
import { OWNER_COOKIE } from "../../../../lib/owner";
import { isBookableDate } from "../../../../lib/slots";

// Cancelling can be reached from the grid (one date) or from /mine/ (every
// date at once) — an explicit whitelist, not the raw form value, decides
// where the redirect lands, so this can't be turned into an open redirect by
// a hand-built request naming some other path.
const RETURN_PATHS = new Set(["/", "/mine/"]);

// The read side of ownership: cancelling never trusts anything the form
// itself sends for *who* is cancelling, only the id in the URL and the owner
// cookie already on the request — so a form built by hand (or a replayed
// request) can free a slot it didn't book only if it also happens to hold
// that browser's cookie.
export const POST: APIRoute = async ({ params, request, cookies, redirect }) => {
  const id = Number(params.id);
  const token = cookies.get(OWNER_COOKIE)?.value;
  const form = await request.formData();
  const returnTo = RETURN_PATHS.has(String(form.get("returnTo"))) ? String(form.get("returnTo")) : "/";
  // The grid's cancel form (returnTo "/") is scoped to one date at a time,
  // same as the booking form beside it — without this, cancelling while
  // looking at any day but today bounced the browser back to today's grid,
  // same bug the booking route itself had until it started sending its date
  // back on redirect too. /mine/ isn't date-scoped, so it never needs this.
  const date = String(form.get("date") ?? "");
  const target = returnTo === "/" && isBookableDate(date) ? `/?date=${date}` : returnTo;
  // Only /mine/ renders a per-booking list to attach an error to — the grid
  // shows one shared table keyed by room/slot, not by booking id.
  const errorParam = id && returnTo === "/mine/" ? `&booking=${id}` : "";
  const errorRedirect = () => redirect(`${target}${target.includes("?") ? "&" : "?"}error=cancel${errorParam}`, 303);

  if (!id || !token) {
    return errorRedirect();
  }

  const cancelled = cancelBooking(id, token);
  if (!cancelled) {
    return errorRedirect();
  }

  bus.emit("cancelled", cancelled);

  // A cancelled slot doesn't sit free if someone was already waiting for it —
  // promote the oldest waitlist entry into a real booking before anyone else
  // gets a chance at the now-empty cell. Broadcasting it as the ordinary
  // "booking" event means every open tab (this one included, on its own
  // redirect) sees the slot go straight from booked to booked-by-someone-
  // else, with no free moment and no new event type for the frontend to
  // learn.
  const promoted = promoteWaitlist(cancelled.roomId, cancelled.date, cancelled.slot);
  if (promoted) {
    bus.emit("booking", promoted);
  }

  return redirect(target, 303);
};
