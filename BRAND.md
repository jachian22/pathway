# Pathway Brand Guidelines

Reference: [workwithpathway.com](https://workwithpathway.com)

## Color Palette

### Primary Colors

| Name          | CSS Variable         | Hex       | Usage                          |
|---------------|---------------------|-----------|--------------------------------|
| Cream         | `--color-cream`     | `#F5F2ED` | Page backgrounds               |
| Charcoal      | `--color-charcoal`  | `#2D2D2D` | Primary text, buttons          |
| Forest Green  | `--color-forest`    | `#2B4D3B` | Logo, accents, links           |
| White         | `--color-white`     | `#FFFFFF` | Cards, button text             |

### Secondary Colors (Illustration Accents)

| Name          | CSS Variable          | Hex       | Usage                          |
|---------------|----------------------|-----------|--------------------------------|
| Terracotta    | `--color-terracotta` | `#C65D3B` | Warm accents                   |
| Navy          | `--color-navy`       | `#1E3A5F` | Cool accents                   |
| Warm Brown    | `--color-brown`      | `#8B6914` | Earthy accents                 |
| Sky Blue      | `--color-sky`        | `#87CEEB` | Light accents                  |

### Semantic Colors

| Name          | CSS Variable          | Hex       | Usage                          |
|---------------|----------------------|-----------|--------------------------------|
| Success       | `--color-success`    | `#2B4D3B` | Resolved states (forest green) |
| Warning       | `--color-warning`    | `#C65D3B` | In progress (terracotta)       |
| Error         | `--color-error`      | `#B91C1C` | Escalated states               |

---

## Typography

### Font Families

| Type      | Font                    | CSS Variable      | Fallback Stack                           |
|-----------|------------------------|-------------------|------------------------------------------|
| Serif     | Playfair Display       | `--font-serif`    | Georgia, Times New Roman, serif          |
| Sans      | Geist Sans (or Inter)  | `--font-sans`     | system-ui, sans-serif                    |

### Type Scale

| Element        | Size     | Weight   | Style    | Font    |
|----------------|----------|----------|----------|---------|
| Hero Headline  | 4xl-6xl  | 400      | Italic   | Serif   |
| Section Header | 2xl-3xl  | 400      | Italic   | Serif   |
| Card Title     | lg-xl    | 600      | Normal   | Sans    |
| Body           | base     | 400      | Normal   | Sans    |
| Caption        | sm       | 400      | Normal   | Sans    |
| Button         | base     | 500      | Normal   | Sans    |

---

## UI Components

### Buttons

**Primary Button**
```
- Background: charcoal (#2D2D2D)
- Text: white
- Border radius: full (pill shape)
- Padding: px-8 py-3
- Hover: slightly lighter charcoal
```

**Secondary Button**
```
- Background: transparent
- Text: charcoal
- Border: 1px charcoal
- Border radius: full
- Hover: charcoal bg, white text
```

### Cards

```
- Background: white
- Border radius: lg (0.5rem)
- Shadow: subtle (shadow-sm)
- Padding: p-6
- Optional: left accent border (4px, forest green)
```

### Status Badges

| Status      | Background          | Text      |
|-------------|---------------------|-----------|
| Resolved    | forest green (10%)  | forest    |
| In Progress | terracotta (10%)    | terracotta|
| Escalated   | red (10%)           | red       |

---

## Layout Principles

### Spacing
- Page max-width: 1280px (7xl)
- Section padding: py-16 to py-24
- Content padding: px-4 (mobile), px-8 (desktop)
- Card gaps: gap-6 to gap-8

### Grid
- Hero: 2-column asymmetric (text 40%, illustration 60%)
- Features: 3-column grid on desktop
- Cards: responsive grid with auto-fit

### Whitespace
- Generous padding throughout
- Clear section separation
- Breathing room around CTAs

---

## Imagery Style

### Illustrations
- Hand-drawn, watercolor-like aesthetic
- Warm, inviting scenes
- People-focused (community, dining)
- Urban/street cafe vibes

### Icons
- Simple, line-based
- Consistent stroke width
- Forest green or charcoal

### Logo
- "PATHWAY" wordmark: sans-serif, uppercase, letterspaced
- Icon: metallic/gradient arrows
- Clear space: minimum 1x logo height on all sides

---

## Tone & Voice

- **Approachable**: Friendly, not corporate
- **Confident**: "knows your restaurant better than anyone"
- **Human-centric**: AI that works *with* you
- **Simple**: Clear, jargon-free language

---

## Chat UI System

The chat interface extends the core brand with additional colors and components optimized for conversational UI.

### Surface Layers

Chat interfaces use layered surfaces for visual hierarchy:

| Layer      | CSS Variable       | Hex       | Usage                              |
|------------|-------------------|-----------|-----------------------------------|
| Surface 0  | `--color-surface-0` | `#FFFFFF` | Cards, chat container, input bg   |
| Surface 1  | `--color-surface-1` | `#FAFAF8` | AI message bubbles                |
| Surface 2  | `--color-surface-2` | `#F5F2ED` | Page background (cream)           |
| Surface 3  | `--color-surface-3` | `#EBE8E2` | Hover states, dividers            |

### Message Bubbles

| Element    | Background | Text    | Notes                              |
|------------|-----------|---------|-----------------------------------|
| User msg   | Forest    | White   | Right-aligned, rounded-br-md      |
| AI msg     | Surface-1 | Charcoal| Left-aligned, rounded-bl-md, border |

### Text Hierarchy

| Level      | CSS Variable           | Hex       | Usage                     |
|------------|------------------------|-----------|---------------------------|
| Primary    | `--color-text-primary`  | `#2D2D2D` | Main body text            |
| Secondary  | `--color-text-secondary`| `#6B6B6B` | Timestamps, metadata      |
| Muted      | `--color-text-muted`    | `#9B9B9B` | Placeholders, hints       |
| Inverse    | `--color-text-inverse`  | `#FFFFFF` | Text on dark backgrounds  |

### Chat Components

```html
<!-- Chat container -->
<div class="chat-container">

  <!-- Chat header -->
  <div class="chat-header">
    <div class="ai-avatar">P</div>
    <span>Pathway Assistant</span>
  </div>

  <!-- Messages -->
  <div class="msg-ai">
    Hello! How can I help you plan your day?
    <div class="msg-meta">2:34 PM</div>
  </div>

  <div class="msg-user">
    What's happening in NYC this weekend?
    <div class="msg-meta">2:35 PM</div>
  </div>

  <!-- Typing indicator -->
  <div class="typing-indicator">
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  </div>

  <!-- Input area -->
  <div class="chat-input-container">
    <input class="chat-input" placeholder="Ask me anything..." />
    <button class="chat-send-btn">Send</button>
  </div>

</div>
```

### Suggestion Chips

Quick-action buttons for common queries:

```html
<div class="flex gap-2 flex-wrap">
  <button class="suggestion-chip">Events near me</button>
  <button class="suggestion-chip">Weekend plans</button>
  <button class="suggestion-chip">Restaurant ideas</button>
</div>
```

### Code Blocks

For AI responses containing code or data:

```html
<!-- Block code -->
<pre class="msg-code">
{
  "event": "Jazz in the Park",
  "date": "Saturday, 3pm"
}
</pre>

<!-- Inline code -->
<p>Check the <code class="msg-code-inline">events</code> endpoint.</p>
```

### Empty State

When chat has no messages:

```html
<div class="chat-empty">
  <div class="ai-avatar mb-4">P</div>
  <h2 class="chat-empty-title">Plan your perfect NYC day.</h2>
  <p class="chat-empty-subtitle">Ask me about events, weather, restaurants, and more.</p>
</div>
```

### Design Rationale

| Decision | Reasoning |
|----------|-----------|
| User = Forest green | Brand color ownership, clear "you" vs "AI" distinction |
| AI = Near-white | Neutral, doesn't compete with content, easy on eyes |
| White container on cream | Elevates chat area, creates focus |
| Rounded corners (2xl) | Friendly, conversational feel |
| Subtle borders on AI msgs | Definition without heaviness |
| Forest focus rings | Brand consistency in interactions |

---

## Tailwind Usage

The brand colors are configured in `src/styles/globals.css` using Tailwind v4's `@theme` directive.

```css
/* Example usage */
<div class="bg-cream text-charcoal">
  <h1 class="font-serif italic text-4xl">Headline</h1>
  <p class="font-sans">Body text</p>
  <button class="bg-charcoal text-white rounded-full px-8 py-3">
    CTA Button
  </button>
</div>
```

---

## File References

- Brand colors: `src/styles/globals.css`
- This document: `BRAND.md`
- Logo: `public/pathway-logo.png` (to be added)
