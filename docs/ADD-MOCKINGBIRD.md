# Dictation in a Hub page

Load `/src/mockingbird.js` with `data-manual="true"`, then initialize after Clerk is ready:

```html
<script src="https://YOUR_CANONICAL_HOST/src/mockingbird.js" data-manual="true"></script>
<script>
Mockingbird.init({
  transcribeEndpoint: 'https://YOUR_CANONICAL_HOST/api/transcribe',
  formatEndpoint: 'https://YOUR_CANONICAL_HOST/api/format',
  getToken: () => window.Clerk.session?.getToken(),
  learn: false,
  hotkey: 'Ctrl+Space'
});
</script>
```

Replace the documented hostname with the actual deployment URL. Configure the Hub's browser origin in both Clerk's authorized parties and the API CORS allowlist. The authenticated user must have paid or gifted Pro access. Never embed a shared API key or service-role credential.

The consumer widget treats utterances as dictation. Legacy connector/action handlers are not called from its normal finish pipeline. Standalone browser recognition may still work without a server, but it is separate from cloud Pro dictation and follows the browser's speech service behavior.

The consumer account page is a complete standalone workspace. Linking the Hub's Mockingbird catalog entry to that page is the first integration; embedding the widget in additional Hub fields is optional later work.
