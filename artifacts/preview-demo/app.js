const status = document.querySelector('#status');
const buttons = [document.querySelector('#heroAction'), document.querySelector('#navAction')].filter(Boolean);
buttons.forEach((button) => {
  button.addEventListener('click', () => {
    status.textContent = 'Interaction confirmed · local script is running';
    status.style.color = '#91aaff';
    button.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-3px)' }, { transform: 'translateY(0)' }], { duration: 360, easing: 'ease-out' });
  });
});
