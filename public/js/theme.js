;(function(){
  var key='theme'
  var cur=localStorage.getItem(key)||'dark'
  if(cur==='light') document.documentElement.classList.add('light')
  function setTheme(t){localStorage.setItem(key,t);document.documentElement.classList.toggle('light',t==='light')}
  document.addEventListener('click',function(e){var el=e.target; if(el && el.id==='themeToggle'){var next=document.documentElement.classList.contains('light')?'dark':'light';setTheme(next)}})
})()