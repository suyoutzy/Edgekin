chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  } catch {
    // Browser-internal and other protected pages do not permit script injection.
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d94e35' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: '当前页面不允许扩展运行' });
  }
});
