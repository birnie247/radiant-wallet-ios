/**
 * The app's logo: the official Radiant mark (Apache-2.0, vendored under
 * assets/brand) inside a rounded tile.
 *
 * The mark itself is the ecosystem's own artwork rather than something redrawn
 * here — the tile only gives it a surface, so it reads as an app icon at 30px
 * and as a hero at 64px without a second asset.
 */
import mark from "../assets/radiant-mark.png";

export default function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <img src={mark} alt="" />
    </span>
  );
}
