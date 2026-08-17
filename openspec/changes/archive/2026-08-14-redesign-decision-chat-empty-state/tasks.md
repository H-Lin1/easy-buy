## 1. Empty State Structure

- [x] 1.1 Add a derived empty-conversation state that keeps unsubmitted text and screenshots in the starter experience
- [x] 1.2 Replace the pre-submit chat scaffolding with a focused starter containing guidance and the existing composer
- [x] 1.3 Keep the existing submitted conversation, analysis progress, report, and persistence flow unchanged

## 2. Starter Interactions

- [x] 2.1 Add four common decision prompts for duplication, outfit potential, price value, and impulse risk
- [x] 2.2 Make prompt selection fill an editable draft without submitting or starting analysis
- [x] 2.3 Add a starter variant to the shared composer without duplicating upload, drag-and-drop, clear, or submit behavior

## 3. Responsive Presentation

- [x] 3.1 Present prompt entries in two columns on desktop and one column on mobile
- [x] 3.2 Verify the heading, composer controls, helper copy, and prompt entries do not overlap or overflow at 390px width

## 4. Verification

- [x] 4.1 Run targeted ESLint and TypeScript checks for the changed page
- [x] 4.2 Run the Next.js production build
- [x] 4.3 Verify the authenticated empty state and prompt-fill interaction in a desktop browser
- [x] 4.4 Verify the authenticated empty state at a 390px mobile viewport

## 5. Minimal Starter Refinement

- [x] 5.1 Remove the decorative logo and four starter task guides
- [x] 5.2 Update the starter heading, single-line subtitle, and textarea placeholder to the approved copy
- [x] 5.3 Remove the starter textarea focus border, outline, and ring while preserving the composer container
- [x] 5.4 Run OpenSpec strict validation, ESLint, TypeScript, and the production build
- [x] 5.5 Verify the default and focused starter states on desktop and at a 390px mobile viewport

## 6. Submitted Request Presentation

- [x] 6.1 Update the submitted conversation header copy and remove the clear action
- [x] 6.2 Replace the user avatar with a compact one-third-size image and themed text bubble
- [x] 6.3 Remove the assistant avatar and identity row from the preparation stage

## 7. Sequential Analysis Progress

- [x] 7.1 Add local request timing and expandable progress state
- [x] 7.2 Reveal progress stages sequentially with an animated Thinking Orb only on the active stage
- [x] 7.3 Replace “思考中” with a collapsible elapsed-time control after report completion
- [x] 7.4 Remove the preparation-stage report placeholder while preserving real reports, errors, and notices

## 8. Verification

- [x] 8.1 Run OpenSpec strict validation, ESLint, TypeScript, and the production build
- [x] 8.2 Verify submitted image/text presentation and sequential progress on desktop
- [x] 8.3 Verify completed elapsed-time expansion and collapse behavior
- [x] 8.4 Verify the preparation and completed states at a 390px mobile viewport
