# Entity Assets

News.AI uses an entity asset catalog so brand/person visuals are reusable and do not depend on image-generation guesses.

## Storage Rule

- Cloudinary is the source of image delivery.
- Supabase stores metadata and lookup records only.
- Git must not store production logos, person photos, generated cutouts, or downloaded reference images.

Cloudinary folder convention:

```text
news-ai/entities/<entity-slug>/logo/icon
news-ai/entities/<entity-slug>/logo/wordmark
news-ai/entities/<entity-slug>/people/<person-slug>/reference
news-ai/entities/<entity-slug>/people/<person-slug>/cutout
news-ai/generated/backgrounds
news-ai/generated/cutouts
news-ai/final-covers
```

## Asset Types

- `logo_icon` is preferred for overlays. It should be the symbol-only logo without company text.
- `logo_wordmark` is allowed only when an icon-only mark is unavailable or unsuitable.
- `person_reference` is used as face/reference input for symbolic founder scenes.
- `person_cutout` is a transparent PNG/WebP cutout, usually from generated metaphor art or a manually approved source.
- `product_photo`, `source_photo`, and `symbol` are optional supporting assets.

## Approval States

- `needs_review`: imported but not yet trusted for production.
- `approved`: safe for Generator/TemplateV1 usage.
- `rejected`: wrong logo, bad quality, wrong person, or poor source.
- `archived`: replaced by a better asset.

## First Entities

The initial migration seeds company records for OpenAI, Anthropic, Google, Apple, Meta, and xAI. It does not seed asset URLs; add those only after uploading verified files to Cloudinary.

## Typical Flow

1. Find or receive an icon-only logo or person reference.
2. Upload it to Cloudinary under the folder convention above.
3. Create/update `entity_assets` with the Cloudinary URL, source URL, and license note.
4. Mark it `approved` after visual review.
5. Generator/TemplateV1 can then use the approved `logo_icon` or `person_reference`.

