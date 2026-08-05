var tab_listeners = {};
var tab_push = {}, tab_lasturl = {};
var selectedId = -1;

function refreshCount() {
	var txt = tab_listeners[selectedId] ? tab_listeners[selectedId].length : 0;
	chrome.tabs.get(selectedId, function() {
		if (!chrome.runtime.lastError) {
			chrome.action.setBadgeText({"text": ''+txt, tabId: selectedId});
			if(txt > 0) {
				chrome.action.setBadgeBackgroundColor({ color: [255, 0, 0, 255]});
			} else {
				chrome.action.setBadgeBackgroundColor({ color: [0, 0, 255, 0] });
			}
		}
	});
}

function logListener(data) {
	chrome.storage.sync.get({
		log_url: ''
	}, function(items) {
		var log_url = items.log_url;
		if(!log_url.length) return;
		var stringData = JSON.stringify(data);
		try {
			fetch(log_url, {
				method: 'post',
				headers: {
					"Content-type": "application/json; charset=UTF-8"
				},
				body: stringData
			});
		} catch(e) { }
	});
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
	console.log('message from cs', msg);
	var tabId = sender.tab.id;
	if(msg.listener) {
		if(msg.listener == 'function () { [native code] }') return;
		msg.parent_url = sender.tab.url;
		if(!tab_listeners[tabId]) tab_listeners[tabId] = [];
		tab_listeners[tabId][tab_listeners[tabId].length] = msg;
		logListener(msg);
	}
	if(msg.pushState) {
		tab_push[tabId] = true;
	}
	if(msg.changePage) {
		delete tab_lasturl[tabId];
	}
	if(msg.log) {
		console.log(msg.log);
	} else {
		refreshCount();
	}
});

chrome.tabs.onUpdated.addListener(function(tabId, props) {
	console.log(props);
	if (props.status == "complete") {
		if(tabId == selectedId) refreshCount();
	} else if(props.status) {
		if(tab_push[tabId]) {
			delete tab_push[tabId];
		} else {
			if(!tab_lasturl[tabId]) {
				tab_listeners[tabId] = [];
			}
		}
	}
	if(props.status == "loading")
		tab_lasturl[tabId] = true;
});

chrome.tabs.onActivated.addListener(function(activeInfo) {
	selectedId = activeInfo.tabId;
	refreshCount();
});

chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
	if(tabs && tabs[0]) {
		selectedId = tabs[0].id;
		refreshCount();
	}
});

chrome.runtime.onConnect.addListener(function(port) {
	port.onMessage.addListener(function(msg) {
		port.postMessage({listeners: tab_listeners});
	});
});