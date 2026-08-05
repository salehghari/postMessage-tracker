var port = chrome.runtime.connect({
	name: "Sample Communication"
});

var currentTargetUrl = "";
var globalListenersData = [];
var currentFilterType = 'all';
var currentSearchQuery = '';

function initTheme() {
	chrome.storage.sync.get({ theme: 'dark' }, function(items) {
		if (items.theme === 'light') {
			document.body.classList.add('light-mode');
		} else {
			document.body.classList.remove('light-mode');
		}
	});
}

function setupThemeToggle() {
	var toggleBtn = document.getElementById('theme-toggle');
	if (toggleBtn) {
		toggleBtn.addEventListener('click', function() {
			document.body.classList.toggle('light-mode');
			var currentTheme = document.body.classList.contains('light-mode') ? 'light' : 'dark';
			chrome.storage.sync.set({ theme: currentTheme });
		});
	}
}

function setupTabs() {
	var navListeners = document.getElementById('nav-listeners');
	var navPoc = document.getElementById('nav-poc');
	var viewListeners = document.getElementById('view-listeners');
	var viewPoc = document.getElementById('view-poc');

	navListeners.addEventListener('click', function() {
		navListeners.classList.add('active');
		navPoc.classList.remove('active');
		viewListeners.classList.add('active');
		viewPoc.classList.remove('active');
	});

	navPoc.addEventListener('click', function() {
		navPoc.classList.add('active');
		navListeners.classList.remove('active');
		viewPoc.classList.add('active');
		viewListeners.classList.remove('active');
	});
}

function setupSearchAndFilters() {
	var searchInput = document.getElementById('search-input');
	searchInput.addEventListener('input', function(e) {
		currentSearchQuery = e.target.value.toLowerCase();
		renderListenersList(globalListenersData);
	});

	var pills = document.querySelectorAll('.pill');
	pills.forEach(function(pill) {
		pill.addEventListener('click', function() {
			pills.forEach(p => p.classList.remove('active'));
			pill.classList.add('active');
			currentFilterType = pill.getAttribute('data-filter');
			renderListenersList(globalListenersData);
		});
	});
}

function setupPocSender() {
	var sendBtn = document.getElementById('btn-send-poc');
	var statusDiv = document.getElementById('poc-status');

	sendBtn.addEventListener('click', function() {
		var origin = document.getElementById('poc-origin').value || '*';
		var payload = document.getElementById('poc-payload').value;

		if (!payload) {
			statusDiv.style.color = '#f38ba8';
			statusDiv.innerText = 'Error: Payload cannot be empty.';
			return;
		}

		chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
			if (tabs && tabs[0]) {
				chrome.tabs.sendMessage(tabs[0].id, {
					action: "FIRE_POST_MESSAGE",
					payload: payload,
					targetOrigin: origin
				}, function(response) {
					if (chrome.runtime.lastError) {
						statusDiv.style.color = '#f38ba8';
						statusDiv.innerText = 'Failed to send message into page.';
					} else if (response && response.status === 'success') {
						statusDiv.style.color = '#a6e3a1';
						statusDiv.innerText = '✓ postMessage payload sent successfully!';
					} else {
						statusDiv.style.color = '#f38ba8';
						statusDiv.innerText = 'Error: ' + (response ? response.message : 'Unknown');
					}
				});
			}
		});
	});
}

function loaded() {
	initTheme();
	setupThemeToggle();
	setupTabs();
	setupSearchAndFilters();
	setupPocSender();

	port.postMessage("get-stuff");
	port.onMessage.addListener(function(msg) {
		chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
			if(tabs && tabs[0]) {
				var selectedId = tabs[0].id;
				globalListenersData = (msg.listeners && msg.listeners[selectedId]) ? msg.listeners[selectedId] : [];
				renderListenersList(globalListenersData);
			}
		});
	});
}

window.onload = loaded;

const RISKY_PATTERNS = [
	{ name: 'Missing Origin Check', regex: /origin/i, invert: true, type: 'danger' },
	{ name: 'Flawed .indexOf() Check', regex: /\.origin\.indexOf\(/i, type: 'warning' },
	{ name: 'Flawed .includes() Check', regex: /\.origin\.includes\(/i, type: 'warning' },
	{ name: 'Regex Origin Match', regex: /\.origin\.match\(|\.origin\.search\(/i, type: 'warning' },
	{ name: 'XSS Sink (eval)', regex: /\beval\s*\(/g, type: 'danger' },
	{ name: 'XSS Sink (innerHTML)', regex: /\.innerHTML\s*=/g, type: 'danger' },
	{ name: 'XSS Sink (outerHTML)', regex: /\.outerHTML\s*=/g, type: 'danger' },
	{ name: 'XSS Sink (document.write)', regex: /document\.write\s*\(/g, type: 'danger' },
	{ name: 'DOM Navigation Sink', regex: /(location\.href|location\.assign|location\.replace)\s*=/g, type: 'warning' },
	{ name: 'Storage Access', regex: /(localStorage|sessionStorage|document\.cookie)/g, type: 'info' }
];

function analyzeCode(codeString) {
	let flags = [];
	if (!/origin/i.test(codeString)) {
		flags.push({ name: 'NO ORIGIN CHECK', type: 'danger' });
	}
	RISKY_PATTERNS.forEach(pattern => {
		if (!pattern.invert && pattern.regex.test(codeString)) {
			flags.push({ name: pattern.name, type: pattern.type });
		}
	});
	return flags;
}

function formatAndHighlightCode(codeString) {
	let safeCode = codeString.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	safeCode = safeCode.replace(/(&quot;|["'`])([\s\S]*?)(&quot;|["'`])/g, '<span class="syn-string">$1$2$3</span>');
	safeCode = safeCode.replace(/(\beval\s*\()|(\.innerHTML\s*=)|(\.outerHTML\s*=)|(document\.write\s*\()/g, '<span class="hl-sink">$&</span>');
	safeCode = safeCode.replace(/(\.origin\.indexOf\()|(\.origin\.includes\()|(location\.href\s*=)/g, '<span class="hl-weak">$&</span>');
	safeCode = safeCode.replace(/\b(function|return|var|let|const|if|else|try|catch|typeof)\b/g, '<span class="syn-keyword">$1</span>');
	return safeCode;
}

function generateExploitHarness(targetUrl, domain) {
	return `<!DOCTYPE html>
<html>
<head>
    <title>postMessage Exploit Harness - ${domain}</title>
</head>
<body>
    <h3>Targeting: ${domain}</h3>
    <iframe id="targetFrame" src="${targetUrl}" width="800" height="600"></iframe>

    <script>
        const iframe = document.getElementById('targetFrame');
        function sendExploitPayload() {
            const payload = { "type": "EXPLOIT_PAYLOAD", "data": "<img src=x onerror=alert(document.domain)>" };
            iframe.contentWindow.postMessage(payload, "*");
        }
        iframe.onload = () => { setTimeout(sendExploitPayload, 1000); };
    </script>
</body>
</html>`;
}

function renderListenersList(listeners) {
	var x = document.getElementById('x');
	if (x && x.parentElement) {
		x.parentElement.removeChild(x);
	}
	x = document.createElement('ol');
	x.id = 'x';
	
	currentTargetUrl = (listeners && listeners.length) ? listeners[0].parent_url : '';
	document.getElementById('h').innerText = currentTargetUrl ? 'Target: ' + currentTargetUrl : 'No postMessage listeners detected.';

	if(listeners) {
		for(var i = 0; i < listeners.length; i++) {
			var listener = listeners[i];
			var flags = analyzeCode(listener.listener);
			var domainStr = (listener.domain || '').toLowerCase();
			var codeStr = (listener.listener || '').toLowerCase();
			var stackStr = (listener.stack || '').toLowerCase();

			// Apply Pill Filters
			if (currentFilterType === 'danger' && !flags.some(f => f.type === 'danger')) continue;
			if (currentFilterType === 'warning' && !flags.some(f => f.type === 'warning')) continue;
			if (currentFilterType === 'no-origin' && !flags.some(f => f.name === 'NO ORIGIN CHECK')) continue;

			// Apply Search Query Filter
			if (currentSearchQuery) {
				var matchesDomain = domainStr.includes(currentSearchQuery);
				var matchesCode = codeStr.includes(currentSearchQuery);
				var matchesStack = stackStr.includes(currentSearchQuery);
				if (!matchesDomain && !matchesCode && !matchesStack) {
					continue;
				}
			}

			var el = document.createElement('li');

			var headerLine = document.createElement('div');
			headerLine.className = 'header-line';
			
			var bel = document.createElement('span');
			bel.className = 'domain';
			bel.innerText = listener.domain || 'unknown-domain';
			
			var win = document.createElement('span');
			win.className = 'win-info';
			win.innerText = (listener.window ? listener.window + ' ' : '') + (listener.hops && listener.hops.length ? listener.hops : '');
			
			headerLine.appendChild(bel);
			headerLine.appendChild(win);
			el.appendChild(headerLine);

			if (flags.length > 0) {
				var badgeContainer = document.createElement('div');
				badgeContainer.className = 'badges';
				flags.forEach(flag => {
					var badge = document.createElement('span');
					badge.className = `badge badge-${flag.type}`;
					badge.innerText = flag.name;
					badgeContainer.appendChild(badge);
				});
				el.appendChild(badgeContainer);
			}

			var sel = document.createElement('div');
			sel.className = 'stack-info';
			if(listener.fullstack) sel.setAttribute('title', listener.fullstack.join("\n\n"));
			sel.innerText = 'Caller: ' + (listener.stack || 'Direct Listener');
			el.appendChild(sel);

			var pel = document.createElement('pre');
			pel.innerHTML = formatAndHighlightCode(listener.listener);
			el.appendChild(pel);

			var actionRow = document.createElement('div');
			actionRow.className = 'action-row';

			var copyBtn = document.createElement('button');
			copyBtn.className = 'btn-copy';
			copyBtn.innerText = '📋 Copy Exploit Harness';
			
			(function(targetUrl, domainName, buttonEl) {
				buttonEl.addEventListener('click', function() {
					var harnessHtml = generateExploitHarness(targetUrl, domainName);
					navigator.clipboard.writeText(harnessHtml).then(function() {
						var origText = buttonEl.innerText;
						buttonEl.innerText = '✓ Copied HTML!';
						setTimeout(function() { buttonEl.innerText = origText; }, 1500);
					});
				});
			})(listener.parent_url || currentTargetUrl, listener.domain || 'Target', copyBtn);

			actionRow.appendChild(copyBtn);
			el.appendChild(actionRow);

			x.appendChild(el);
		}
	}
	document.getElementById('view-listeners').appendChild(x);
}