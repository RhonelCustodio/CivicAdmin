# EmailJS announcement and event notifications

The admin and organizer consoles send a notification when a new announcement or
event is created. Emails are sent to distinct, valid addresses in the Firestore
`residents` collection, excluding disabled and deleted accounts. No Firebase
Cloud Functions or paid Firebase billing is required. EmailJS plan limits
apply; requests are sent sequentially at about one per second, so keep the page
open until delivery finishes.

## Configure EmailJS

1. Create an EmailJS account and connect an email service you are authorized to
   use as the sender.
2. Create separate announcement and event templates with these settings:
   - **To Email:** `{{to_email}}`
   - **Subject:** `Victoria Civic Portal: {{content_type}} - {{title}}`
   - **Body:** include `{{content_type}}`, `{{title}}`, and
     `{{description}}`. For announcement details, use `{{priority}}`. For event
     details, use `{{event_date}}`, `{{event_time}}`, `{{location}}`, and
     `{{category}}`. Optionally include `{{image_url}}`.
3. In the EmailJS dashboard, find the service ID, both template IDs, and public
   key.
4. Add the service ID and public key, plus `announcementTemplateId` and
   `eventTemplateId`, to `CivicAdmin/firebase-config/email-config.js` and
   `CivicOrganizer/firebase-config/email-config.js`. These values are public
   browser configuration; never put a private key or email-service password in
   either file.
5. In EmailJS, restrict allowed origins to the exact website domain where this
   console is hosted.
6. Create a new announcement or event and leave the page open while messages
   send. Older posts are not automatically emailed.

Check the post's `emailDelivery` field in Firestore for `sent`, `partial`,
`failed`, `no_recipients`, or `not_configured`. EmailJS may accept a request
without guaranteeing delivery; check the EmailJS dashboard and recipients'
spam folders if an email is not received.

Because EmailJS is called from the browser, its public key is visible to users
and should be restricted by website origin. The Firebase rules must also
restrict who can create announcements and read resident email addresses. For
stronger server-side protection or more volume, use an authenticated backend
and a provider plan that supports the required delivery.
