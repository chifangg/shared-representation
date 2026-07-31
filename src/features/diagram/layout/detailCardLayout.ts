/**
 * Geometry shared by the bubble detail card and the hook that reframes the
 * camera before it opens.
 *
 * These MUST be one source of truth. The hook eases the camera so the card's
 * outward side (the way the fan opened) has room for it; the card then checks
 * that same room before committing to that side. When the two drifted apart,
 * the hook cleared space for a smaller card than the card actually needed, the
 * fit check failed, and the card silently fell back to some other side, which
 * looked like the outward-direction logic being broken.
 */

/** Width of the card. */
export const CARD_W = 340;
/** Height reserved for the vertical clamp, so the card is centred on the
 *  bubble and kept fully on-screen before its real height is known. */
export const CARD_RESERVE_H = 380;
/** Gap between the bubble's rim and the card's near edge. Generous so the
 *  card never sits on the bubble it points at. */
export const CARD_GAP = 48;
/** Keep the card this far inside the pane. */
export const CARD_MARGIN = 14;
