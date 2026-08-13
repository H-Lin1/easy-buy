## 1. Square Image Presentation

- [x] 1.1 Update the shared closet image presentation so every image uses a shallow warm-white background and `object-contain` without source-specific crop behavior.
- [x] 1.2 Replace the confirmation-card and closet-card fixed image heights with the same responsive 1:1 image region while preserving their existing controls and load callbacks.

## 2. Verification

- [x] 2.1 Run targeted static checks covering both image call sites and ensure no closet image path still requests `cover`.
- [x] 2.2 Run ESLint, TypeScript, production build, strict OpenSpec validation, `git diff --check`, and desktop/mobile visual verification using original and generated image modes.
