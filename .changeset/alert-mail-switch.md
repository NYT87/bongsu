---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/dashboard": minor
---

Emails say why they were sent. An alert email (a connection or a media store that broke) ends with the role that brought
it and a link to turn these emails off; an invite ends with who sent it and that ignoring it does nothing (the link
expires in 7 days). Each person turns alert emails off in the dashboard (Devices & passkeys → Alert emails, new
`users.alert_mail` column, on by default); the push and the dashboard notice still go out.
