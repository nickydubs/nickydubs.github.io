$(window).on('scroll',function (){
  var wScroll = $(this).scrollTop();
  //limit the ufo to slide only 200 px
  if ((wScroll > 0) && (wScroll < 200)) {
    $('#scroll-ufo').css('left',wScroll + 'px');
    $('#scroll-ufo').css('top',wScroll + 'px');
  }
});