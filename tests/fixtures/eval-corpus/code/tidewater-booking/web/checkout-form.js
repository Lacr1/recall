// Client-side checks on the booking form before the customer is sent to the payment page.
const form = document.querySelector('#booking-form')
const seats = form.querySelector('input[name=seats]')
const phone = form.querySelector('input[name=phone]')
const timer = document.querySelector('#hold-timer')

const MAX_GROUP = 12
const HOLD_SECONDS = 10 * 60

form.addEventListener('submit', (event) => {
  const n = Number(seats.value)
  if (!Number.isInteger(n) || n < 1 || n > MAX_GROUP) {
    event.preventDefault()
    showError(seats, 'Choose between 1 and ' + MAX_GROUP + ' people')
  }
  if (!/^\+?[0-9 ]{8,15}$/.test(phone.value)) {
    event.preventDefault()
    showError(phone, 'Enter a mobile number so the guide can reach you')
  }
})

// Shows the customer how long the seats are held for them.
function startHoldCountdown() {
  let left = HOLD_SECONDS
  const tick = setInterval(() => {
    left -= 1
    timer.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')
    if (left <= 0) {
      clearInterval(tick)
      timer.textContent = 'Your hold has expired. Please pick the date again.'
    }
  }, 1000)
}

function showError(input, message) {
  input.setAttribute('aria-invalid', 'true')
  input.nextElementSibling.textContent = message
}

startHoldCountdown()
