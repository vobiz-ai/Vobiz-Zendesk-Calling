const client = ZAFClient.init();

// Helper to find the top_bar client instance
function getTopBarClient() {
  return client.get('instances').then(instancesData => {
    const instances = instancesData.instances;
    for (const guid in instances) {
      if (instances[guid].location === 'top_bar') {
        return client.instance(guid);
      }
    }
    return null;
  });
}

// Listen to Zendesk click-to-dial event
client.on('voice.dialout', function(event) {
  console.log('[VoBiz Background] Click-to-dial event triggered for number:', event.number);

  getTopBarClient().then(topBarClient => {
    if (topBarClient) {
      // 1. Force the top bar panel to slide open/popover
      topBarClient.invoke('popover', 'show')
        .then(() => {
          console.log('[VoBiz Background] Top bar pane displayed.');
        })
        .catch(err => {
          console.error('[VoBiz Background] Error opening popover:', err);
        });

      // 2. Trigger the dialer event inside the top bar softphone
      topBarClient.trigger('cti.triggerDialer', {
        number: event.number,
        userId: event.userId,
        ticketId: event.ticketId
      });
    } else {
      console.warn('[VoBiz Background] top_bar app instance not found. Make sure it is preloaded.');
    }
  }).catch(err => {
    console.error('[VoBiz Background] Error locating top_bar instance:', err);
  });
});

console.log('[VoBiz Background] Background listener initialized successfully.');
