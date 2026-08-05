// 1. Listen for injected postMessage events and forward them
document.addEventListener('postMessageTracker', function(event) {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
            chrome.runtime.sendMessage(event.detail);
        }
    } catch (e) {
        // Extension context was invalidated due to reload; fail silently and safely.
    }
});

// 2. Track page unloads
window.addEventListener('beforeunload', function(event) {
    var storeEvent = new CustomEvent('postMessageTracker', {'detail': {changePage: true}});
    document.dispatchEvent(storeEvent);
});

// 3. Inject the tracker script into the page context
(function() {
    if (document.contentType === 'application/xml') return;
    var script = document.createElement("script");
    script.setAttribute('type', 'text/javascript');
    script.src = chrome.runtime.getURL("inject.js");
    (document.head || document.documentElement).appendChild(script);
    script.onload = function() {
        script.remove();
    };
})();

// 4. Listen for execution commands from the PoC Sender popup tab
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === "FIRE_POST_MESSAGE") {
        try {
            let payloadData = request.payload;
            
            // Attempt to parse string input into JSON if formatted as JSON
            try {
                payloadData = JSON.parse(request.payload);
            } catch (e) {
                // Retain as raw string payload if not JSON
            }

            // Fire message into target window context
            window.postMessage(payloadData, request.targetOrigin || "*");
            sendResponse({ status: "success" });
        } catch (err) {
            sendResponse({ status: "error", message: err.toString() });
        }
    }
    return true;
});