---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
---

Admins and creators connect Instagram and YouTube from the app's Settings (Connect, Reconnect), with the instance's
OAuth apps; without one, the app says the instance admin has to add it first. A connection now lands in the workspace
the flow was started from, in the app as in the dashboard (it used to go to the user's first workspace), and a flow
whose user left that workspace, lost the right to connect or saw it archived before coming back isn't finished.
