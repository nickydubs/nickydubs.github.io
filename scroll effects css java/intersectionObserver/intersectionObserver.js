const elements = Array.from(document.querySelectorAll('.test'));
const observer = new IntersectionObserver(onChange, {
  root: document.documentElement.body, //scollable element, is Body if not specified
  rootMargin: '0px', // grows or shrinks the intersection boundingbox of the root
  threshold: buildThresholdList(parseFloat(elements.length, 2))
});

function buildThresholdList(steps) {
  let thresholds = [];
  
  thresholds.push(0);
  
  for (let i=1.0; i<=steps; i++) {
    const ratio = i/steps;
    thresholds.push(ratio);
  }
  
  return thresholds;
}

function onChange(changes) {
  changes.forEach(change => {
    const $target = change.target;
    if(change.isIntersecting) {
      $target.classList.add('is-visible');
    } else {
      $target.classList.remove('is-visible');
    }
  })
}

elements.forEach(element => observer.observe(element));