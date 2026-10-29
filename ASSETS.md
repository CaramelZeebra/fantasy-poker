# Optional art (Gemini / Nano Banana prompts)

The site works without any of these — it falls back to CSS felt, a striped card back and
initials for avatars. Drop generated images at the paths below (JPG, same names) and they appear automatically.

General tips: ask for PNG, and crop/resize to the sizes listed. Avatars look best if all nine
are generated in the same chat so the style stays consistent ("same style as before, now…").

## Shared style line (paste at the start of every avatar prompt)

> Stylised character portrait for a poker game avatar, head and shoulders, centered, facing slightly
> toward the viewer. Painterly digital illustration with soft rim lighting, rich but muted colours,
> warm low-key casino lighting, dark green-black vignette background. No text, no letters, no cards
> covering the face, no frame. Square 1:1 composition, readable at 64×64 pixels.

## Avatars → `site/assets/avatars/<name>.jpg` (512×512)

| File | Prompt (after the shared style line) |
|---|---|
| `fish.jpg` | A cheerful, slightly clueless tourist in a loud Hawaiian shirt and sunburned nose, clutching a stack of chips too eagerly, wide hopeful eyes. A tiny goldfish-shaped pin on his collar. |
| `station.jpg` | A relaxed, stubborn older woman in a cardigan, reading glasses on a chain, arms folded, unimpressed half-smile that says "I call." A vintage rotary phone charm on her necklace. |
| `nit.jpg` | A tense, buttoned-up accountant type in a grey sweater vest, lips pressed thin, guarding two cards with both hands, suspicious sideways glance. |
| `tag.jpg` | A calm, focused professional player in a dark hoodie and sunglasses pushed up on the head, confident neutral expression, neat chip stacks. |
| `lag.jpg` | A sharp, stylish player in an unbuttoned blazer, sly grin, leaning forward aggressively, one hand mid-shove pushing chips. |
| `maniac.jpg` | A wild-eyed chaotic gambler with messy hair, loosened neon tie, laughing, chips flying in the air around him. |
| `grinder.jpg` | A meticulous math nerd with round glasses and headphones around the neck, a small notebook covered in probability formulas (illegible scribbles), concentrated look. |
| `hero.jpg` | A dramatic player with a slight superhero cape draped over a casual shirt, squinting with intense "I know you're bluffing" confidence, finger pointing at the viewer. |
| `custom.jpg` | A mysterious silhouetted figure in a fedora with only a confident smile and glinting eyes visible, poker chips in front. |

## Felt texture → `site/assets/felt.jpg` (about 1600×1000, landscape)

The image is stretched over the whole table once, so it doesn't need to tile.

> Generate an image: a flat, top-down macro photo of plain green wool felt fabric. Soft even lighting,
> fine fuzzy fibres, subtle natural texture, mid-tone emerald green, filling the whole frame. Landscape 16:10.

Keep gambling words (poker, casino, card table, chips) out of this one; Gemini sometimes refuses
with a vague "I don't have access to that content" when they're in. Fallback that almost always
works: *"Generate an image of green felt fabric, close-up, filling the frame."*

If it adds objects (chips, cards, a table edge), follow up with: *"Same image but only the fabric,
zoomed in so the felt fills the whole frame."* If it's too busy or dark, ask for *"flatter, lower
contrast, lighter."* The page blends it softly over its own green, so subtle works best.

## Card back → `site/assets/card-back.jpg` (500×700)

> Playing card back design, portrait 5:7 ratio, flat front-facing, full bleed. Deep burgundy with an
> intricate symmetrical gold filigree pattern and a small central emblem combining a spade and a
> crown. Elegant vintage casino style, crisp clean lines, no text, no border shadow, no perspective.
