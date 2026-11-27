---
"@bongsu/web": patch
"@bongsu/dashboard": patch
---

The workspace switcher's role pill and the dashboard's filled red buttons (in dark mode) now reach WCAG AA contrast. In
the app, a button that asks before it acts moves the focus to Cancel when it asks and back to itself after, so the
keyboard doesn't lose its place.
