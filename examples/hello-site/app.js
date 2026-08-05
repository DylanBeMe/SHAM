document.querySelector('#button').addEventListener('click', () => {
  document.querySelector('#message').textContent = `JavaScript works — ${new Date().toLocaleTimeString()}`;
});
