#import <Cocoa/Cocoa.h>
#import <signal.h>

static const NSInteger kColumns = 8;
static const NSInteger kRows = 9;
static const CGFloat kSpriteAspectRatio = 192.0 / 208.0;
static NSString * const kNotificationModeCritical = @"critical";
static NSString * const kNotificationModeProgress = @"progress";
static NSString * const kNotificationModeDefaultsKey = @"duotuanPetNotificationMode";
static NSString * const kPetSizeDefaultsKey = @"duotuanPetSize";
static const NSTimeInterval kActiveTaskReconcileInterval = 5.0;
static const NSTimeInterval kActiveTaskStaleInterval = 30.0 * 60.0;

typedef NS_ENUM(NSInteger, PetAnimationState) {
  PetAnimationStateIdle = 0,
  PetAnimationStateRunningRight,
  PetAnimationStateRunningLeft,
  PetAnimationStateJumping,
  PetAnimationStateWaiting,
  PetAnimationStateRunning,
  PetAnimationStateReview,
  PetAnimationStateFailed
};

typedef NS_ENUM(NSInteger, BubbleDisplayState) {
  BubbleDisplayStateNone = 0,
  BubbleDisplayStateGeneric,
  BubbleDisplayStateTaskList,
  BubbleDisplayStateTaskDetail
};

typedef struct {
  NSInteger column;
  NSInteger row;
  NSTimeInterval duration;
} SpriteFrame;

static const SpriteFrame kIdleFrames[] = {
  {0, 0, 0.28},
  {1, 0, 0.11},
  {2, 0, 0.11},
  {3, 0, 0.14},
  {4, 0, 0.14},
  {0, 0, 0.32}
};
static const NSUInteger kIdleFrameCount = sizeof(kIdleFrames) / sizeof(kIdleFrames[0]);

@interface PetView : NSView
- (instancetype)initWithImage:(NSImage *)image petName:(NSString *)petName codexUri:(NSString *)codexUri size:(NSSize)size;
- (void)setAnimationState:(PetAnimationState)state;
- (void)setBadgeCount:(NSUInteger)badgeCount;
@end

@interface DraggableBubbleView : NSView {
  NSPoint _mouseDownScreenPoint;
  NSPoint _windowOriginAtMouseDown;
}
@end

@implementation DraggableBubbleView

- (void)mouseDown:(NSEvent *)event {
  _mouseDownScreenPoint = [self.window convertPointToScreen:event.locationInWindow];
  _windowOriginAtMouseDown = self.window.frame.origin;
}

- (void)mouseDragged:(NSEvent *)event {
  if (!self.window) { return; }
  NSPoint current = [self.window convertPointToScreen:event.locationInWindow];
  CGFloat dx = current.x - _mouseDownScreenPoint.x;
  CGFloat dy = current.y - _mouseDownScreenPoint.y;
  [self.window setFrameOrigin:NSMakePoint(_windowOriginAtMouseDown.x + dx,
                                          _windowOriginAtMouseDown.y + dy)];
}

@end

@interface TaskChevronButton : NSButton {
  BOOL _hovered;
  NSTrackingArea *_trackingArea;
}
@property (nonatomic, copy) NSString *taskKey;
@end

@implementation TaskChevronButton

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (!self) {
    return nil;
  }
  self.bordered = NO;
  self.title = @"";
  self.wantsLayer = YES;
  self.toolTip = @"展开";
  [self setAccessibilityLabel:@"展开任务详情"];
  return self;
}

- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (_trackingArea) {
    [self removeTrackingArea:_trackingArea];
  }
  _trackingArea = [[NSTrackingArea alloc] initWithRect:NSZeroRect
                                               options:NSTrackingMouseEnteredAndExited |
                                                       NSTrackingActiveAlways |
                                                       NSTrackingInVisibleRect
                                                 owner:self
                                              userInfo:nil];
  [self addTrackingArea:_trackingArea];
}

- (void)mouseEntered:(NSEvent *)event {
  _hovered = YES;
  self.needsDisplay = YES;
}

- (void)mouseExited:(NSEvent *)event {
  _hovered = NO;
  self.needsDisplay = YES;
}

- (void)drawRect:(NSRect)dirtyRect {
  NSRect circleRect = NSIntegralRect(NSInsetRect(self.bounds, 4, 4));
  NSBezierPath *circle = [NSBezierPath bezierPathWithOvalInRect:circleRect];
  [[NSColor colorWithWhite:1.0 alpha:0.92] setFill];
  [circle fill];
  [[NSColor colorWithWhite:0.50 alpha:0.95] setStroke];
  circle.lineWidth = 2.0;
  [circle stroke];

  if (!_hovered) {
    return;
  }

  NSString *arrow = @"›";
  NSDictionary *attributes = @{
    NSFontAttributeName: [NSFont boldSystemFontOfSize:28],
    NSForegroundColorAttributeName: [NSColor colorWithWhite:0.35 alpha:1.0]
  };
  NSSize textSize = [arrow sizeWithAttributes:attributes];
  NSPoint textPoint = NSMakePoint(NSMidX(circleRect) - textSize.width / 2.0 + 1.0,
                                  NSMidY(circleRect) - textSize.height / 2.0 + 1.0);
  [arrow drawAtPoint:textPoint withAttributes:attributes];
}

@end

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
- (void)quitPet:(id)sender;
- (void)openCodex:(id)sender;
- (void)expandLatestBubble:(id)sender;
- (void)toggleTaskBubble:(id)sender;
- (void)showTaskListBubble:(id)sender;
- (void)expandTaskBubble:(id)sender;
- (void)setCriticalNotificationMode:(id)sender;
- (void)setProgressNotificationMode:(id)sender;
- (void)editPetSize:(id)sender;
@end

@implementation PetView {
  NSImage *_image;
  NSString *_codexUri;
  PetAnimationState _state;
  PetAnimationState _restingState;
  NSUInteger _frameIndex;
  NSTimer *_timer;
  BOOL _dragging;
  NSPoint _dragStartScreenPoint;
  NSPoint _dragStartWindowOrigin;
  CGFloat _sourceFrameWidth;
  CGFloat _sourceFrameHeight;
  NSUInteger _badgeCount;
}

- (instancetype)initWithImage:(NSImage *)image petName:(NSString *)petName codexUri:(NSString *)codexUri size:(NSSize)size {
  self = [super initWithFrame:NSMakeRect(0, 0, size.width, size.height)];
  if (!self) {
    return nil;
  }

  _image = image;
  _codexUri = [codexUri copy];
  NSSize imageSize = image.size;
  _sourceFrameWidth = imageSize.width / (CGFloat)kColumns;
  _sourceFrameHeight = imageSize.height / (CGFloat)kRows;
  _state = PetAnimationStateIdle;
  _restingState = PetAnimationStateIdle;
  _frameIndex = 0;
  self.wantsLayer = YES;
  self.layer.backgroundColor = NSColor.clearColor.CGColor;
  self.toolTip = petName;
  self.menu = [self makeMenu];
  [self scheduleNextFrame];
  return self;
}

- (void)drawRect:(NSRect)dirtyRect {
  [NSColor.clearColor setFill];
  NSRectFill(dirtyRect);

  SpriteFrame frame = [self currentFrame];
  NSSize imageSize = _image.size;
  NSRect sourceRect = NSMakeRect(
    (CGFloat)frame.column * _sourceFrameWidth,
    imageSize.height - (CGFloat)(frame.row + 1) * _sourceFrameHeight,
    _sourceFrameWidth,
    _sourceFrameHeight
  );
  NSRect drawRect = NSIntegralRect([self aspectFitRectForBounds:self.bounds]);

  NSGraphicsContext.currentContext.imageInterpolation = NSImageInterpolationNone;
  [_image drawInRect:drawRect
            fromRect:sourceRect
           operation:NSCompositingOperationSourceOver
            fraction:1.0
      respectFlipped:NO
               hints:nil];

  [self drawBadgeInRect:self.bounds];
}

- (void)mouseDown:(NSEvent *)event {
  NSPoint localPoint = [self convertPoint:event.locationInWindow fromView:nil];
  if (_badgeCount > 0 && NSPointInRect(localPoint, [self badgeRectForBounds:self.bounds])) {
    [(AppDelegate *)NSApp.delegate toggleTaskBubble:nil];
    return;
  }

  if (event.clickCount >= 2) {
    [(AppDelegate *)NSApp.delegate openCodex:nil];
    return;
  }

  _dragging = YES;
  _dragStartScreenPoint = [self screenPointForEvent:event];
  _dragStartWindowOrigin = self.window.frame.origin;
  [self setTransientAnimationState:PetAnimationStateJumping];
}

- (void)mouseDragged:(NSEvent *)event {
  if (!_dragging || !self.window) {
    return;
  }

  NSPoint currentScreenPoint = [self screenPointForEvent:event];
  CGFloat deltaX = currentScreenPoint.x - _dragStartScreenPoint.x;
  CGFloat deltaY = currentScreenPoint.y - _dragStartScreenPoint.y;
  [self.window setFrameOrigin:NSMakePoint(_dragStartWindowOrigin.x + deltaX, _dragStartWindowOrigin.y + deltaY)];

  if (deltaX > 4.0) {
    [self setTransientAnimationState:PetAnimationStateRunningRight];
  } else if (deltaX < -4.0) {
    [self setTransientAnimationState:PetAnimationStateRunningLeft];
  } else {
    [self setTransientAnimationState:PetAnimationStateJumping];
  }
}

- (void)mouseUp:(NSEvent *)event {
  _dragging = NO;
  [self setTransientAnimationState:_restingState];
}

- (void)scheduleNextFrame {
  SpriteFrame frame = [self currentFrame];
  self.needsDisplay = YES;
  [_timer invalidate];
  _timer = [NSTimer scheduledTimerWithTimeInterval:frame.duration
                                           target:self
                                         selector:@selector(advanceFrame:)
                                         userInfo:nil
                                          repeats:NO];
}

- (void)advanceFrame:(NSTimer *)timer {
  _frameIndex = (_frameIndex + 1) % [self frameCountForState:_state];
  [self scheduleNextFrame];
}

- (void)setAnimationState:(PetAnimationState)state {
  _restingState = state;
  [self setTransientAnimationState:state];
}

- (void)setTransientAnimationState:(PetAnimationState)state {
  if (_state == state) {
    return;
  }

  _state = state;
  _frameIndex = 0;
  [self scheduleNextFrame];
}

- (void)setBadgeCount:(NSUInteger)badgeCount {
  _badgeCount = badgeCount;
  self.needsDisplay = YES;
}

- (SpriteFrame)currentFrame {
  if (_state == PetAnimationStateIdle) {
    return kIdleFrames[_frameIndex % kIdleFrameCount];
  }

  NSInteger row = [self rowForState:_state];
  NSUInteger frameCount = [self frameCountForState:_state];
  NSUInteger column = _frameIndex % frameCount;
  NSTimeInterval duration = column == frameCount - 1 ? 0.22 : 0.12;
  if (_state == PetAnimationStateJumping) {
    duration = column == frameCount - 1 ? 0.28 : 0.14;
  }

  SpriteFrame frame = { (NSInteger)column, row, duration };
  return frame;
}

- (NSUInteger)frameCountForState:(PetAnimationState)state {
  switch (state) {
    case PetAnimationStateRunningRight:
    case PetAnimationStateRunningLeft:
      return 8;
    case PetAnimationStateJumping:
      return 5;
    case PetAnimationStateWaiting:
    case PetAnimationStateRunning:
    case PetAnimationStateReview:
      return 6;
    case PetAnimationStateFailed:
      return 8;
    case PetAnimationStateIdle:
    default:
      return kIdleFrameCount;
  }
}

- (NSInteger)rowForState:(PetAnimationState)state {
  switch (state) {
    case PetAnimationStateRunningRight:
      return 1;
    case PetAnimationStateRunningLeft:
      return 2;
    case PetAnimationStateJumping:
      return 4;
    case PetAnimationStateFailed:
      return 5;
    case PetAnimationStateWaiting:
      return 6;
    case PetAnimationStateRunning:
      return 7;
    case PetAnimationStateReview:
      return 8;
    case PetAnimationStateIdle:
    default:
      return 0;
  }
}

- (NSPoint)screenPointForEvent:(NSEvent *)event {
  return [self.window convertPointToScreen:event.locationInWindow];
}

- (NSRect)aspectFitRectForBounds:(NSRect)bounds {
  CGFloat targetWidth = bounds.size.width;
  CGFloat targetHeight = bounds.size.height;
  CGFloat currentAspect = targetWidth / targetHeight;

  if (currentAspect > kSpriteAspectRatio) {
    targetWidth = targetHeight * kSpriteAspectRatio;
  } else {
    targetHeight = targetWidth / kSpriteAspectRatio;
  }

  return NSMakeRect(
    NSMidX(bounds) - targetWidth / 2.0,
    NSMidY(bounds) - targetHeight / 2.0,
    targetWidth,
    targetHeight
  );
}

- (NSRect)badgeRectForBounds:(NSRect)bounds {
  CGFloat size = MIN(34.0, MAX(26.0, bounds.size.width * 0.22));
  return NSMakeRect(NSMaxX(bounds) - size - 6.0,
                    NSMaxY(bounds) - size - 4.0,
                    size,
                    size);
}

- (void)drawBadgeInRect:(NSRect)bounds {
  if (_badgeCount == 0) {
    return;
  }

  NSRect badgeRect = NSIntegralRect([self badgeRectForBounds:bounds]);
  NSBezierPath *background = [NSBezierPath bezierPathWithOvalInRect:badgeRect];
  [[NSColor colorWithCalibratedRed:0.90 green:0.94 blue:1.00 alpha:0.98] setFill];
  [background fill];
  [[NSColor colorWithWhite:1.0 alpha:0.92] setStroke];
  background.lineWidth = 1.0;
  [background stroke];

  NSString *label = _badgeCount > 99 ? @"99+" : [NSString stringWithFormat:@"%lu", (unsigned long)_badgeCount];
  NSDictionary *attributes = @{
    NSFontAttributeName: [NSFont boldSystemFontOfSize:15],
    NSForegroundColorAttributeName: [NSColor blackColor]
  };
  NSSize textSize = [label sizeWithAttributes:attributes];
  NSPoint textPoint = NSMakePoint(NSMidX(badgeRect) - textSize.width / 2.0,
                                  NSMidY(badgeRect) - textSize.height / 2.0);
  [label drawAtPoint:textPoint withAttributes:attributes];
}

- (NSMenu *)makeMenu {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  if (_codexUri.length > 0) {
    NSMenuItem *openCodex = [[NSMenuItem alloc] initWithTitle:@"打开 Codex" action:@selector(openCodex:) keyEquivalent:@""];
    openCodex.target = NSApp.delegate;
    [menu addItem:openCodex];
  }

  NSMenu *modeMenu = [[NSMenu alloc] initWithTitle:@"提醒模式"];
  NSMenuItem *critical = [[NSMenuItem alloc] initWithTitle:@"关键提醒" action:@selector(setCriticalNotificationMode:) keyEquivalent:@""];
  critical.target = NSApp.delegate;
  [modeMenu addItem:critical];
  NSMenuItem *progress = [[NSMenuItem alloc] initWithTitle:@"进度提醒" action:@selector(setProgressNotificationMode:) keyEquivalent:@""];
  progress.target = NSApp.delegate;
  [modeMenu addItem:progress];
  NSMenuItem *modeItem = [[NSMenuItem alloc] initWithTitle:@"提醒模式" action:nil keyEquivalent:@""];
  modeItem.submenu = modeMenu;
  [menu addItem:modeItem];

  NSMenuItem *size = [[NSMenuItem alloc] initWithTitle:@"编辑大小..." action:@selector(editPetSize:) keyEquivalent:@""];
  size.target = NSApp.delegate;
  [menu addItem:size];

  NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"关闭宠物" action:@selector(quitPet:) keyEquivalent:@""];
  quit.target = NSApp.delegate;
  [menu addItem:quit];
  return menu;
}

@end

@implementation AppDelegate {
  NSWindow *_window;
  NSWindow *_bubbleWindow;
  NSTimer *_bubbleTimer;
  NSTimer *_sessionMonitorTimer;
  NSTimer *_activeTaskReconcileTimer;
  dispatch_queue_t _activeTaskReconcileQueue;
  NSString *_pidFilePath;
  NSString *_codexHomePath;
  NSString *_codexUri;
  NSString *_eventLogPath;
  NSString *_notificationMode;
  unsigned long long _eventLogOffset;
  NSMutableDictionary<NSString *, NSNumber *> *_fileOffsets;
  NSMutableDictionary<NSString *, NSString *> *_fileTitles;
  NSMutableDictionary<NSString *, NSString *> *_fileFirstMessages;
  NSMutableDictionary<NSString *, NSString *> *_fileTaskKeys;
  NSMutableDictionary<NSString *, NSString *> *_legacyTaskKeysByTitle;
  NSMutableDictionary<NSString *, NSDate *> *_lastProgressByTurn;
  NSMutableSet<NSString *> *_seenEventKeys;
  NSMutableSet<NSString *> *_activeTaskKeys;
  NSMutableDictionary<NSString *, NSDictionary *> *_activeTaskSummaries;
  NSMutableDictionary<NSString *, NSDate *> *_activeTaskLastUpdatedAt;
  NSMutableArray<NSString *> *_activeTaskOrder;
  NSMutableDictionary<NSString *, NSDictionary *> *_sessionSummaryCache;
  NSDate *_monitorStartedAt;
  NSString *_latestBubbleTitle;
  NSString *_latestBubbleBody;
  CGFloat _petWidth;
  BubbleDisplayState _bubbleDisplayState;
  BOOL _reconcileInFlight;
  BOOL _ownsPidFile;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSString *spritesheetPath = [self valueAfter:@"--spritesheet" inArguments:arguments] ?: [self defaultSpritesheetPath];
  NSString *petName = [self valueAfter:@"--pet-name" inArguments:arguments] ?: @"多多团团";
  _pidFilePath = [self valueAfter:@"--pid-file" inArguments:arguments] ?: [self defaultPidFilePath];
  _codexUri = [[self valueAfter:@"--codex-uri" inArguments:arguments] ?: @"" copy];
  _codexHomePath = [[self valueAfter:@"--codex-home" inArguments:arguments] ?: [self defaultCodexHomePath] copy];
  NSString *modeArgument = [self valueAfter:@"--notification-mode" inArguments:arguments] ?: kNotificationModeCritical;
  _notificationMode = [[self restoredNotificationModeFromArgument:modeArgument] copy];
  _petWidth = [self restoredPetWidthFromArgument:[self valueAfter:@"--pet-size" inArguments:arguments]];
  _fileOffsets = [NSMutableDictionary dictionary];
  _fileTitles = [NSMutableDictionary dictionary];
  _fileFirstMessages = [NSMutableDictionary dictionary];
  _fileTaskKeys = [NSMutableDictionary dictionary];
  _legacyTaskKeysByTitle = [NSMutableDictionary dictionary];
  _lastProgressByTurn = [NSMutableDictionary dictionary];
  _seenEventKeys = [NSMutableSet set];
  _activeTaskKeys = [NSMutableSet set];
  _activeTaskSummaries = [NSMutableDictionary dictionary];
  _activeTaskLastUpdatedAt = [NSMutableDictionary dictionary];
  _activeTaskOrder = [NSMutableArray array];
  _sessionSummaryCache = [NSMutableDictionary dictionary];
  _activeTaskReconcileQueue = dispatch_queue_create("local.codex-hud.duotuan.active-task-reconcile", DISPATCH_QUEUE_SERIAL);
  _monitorStartedAt = [NSDate date];
  _bubbleDisplayState = BubbleDisplayStateNone;
  _reconcileInFlight = NO;

  if (![self acquireSingleInstanceLock:_pidFilePath]) {
    [NSApp terminate:nil];
    return;
  }

  NSImage *image = [[NSImage alloc] initWithContentsOfFile:spritesheetPath];
  if (!image) {
    fprintf(stderr, "Unable to load spritesheet: %s\n", spritesheetPath.UTF8String);
    [NSApp terminate:nil];
    return;
  }

  NSSize size = [self petSizeForWidth:_petWidth];
  NSWindow *petWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect([self restoredXForSize:size], [self restoredYForSize:size], size.width, size.height)
                                                    styleMask:NSWindowStyleMaskBorderless
                                                      backing:NSBackingStoreBuffered
                                                        defer:NO];
  petWindow.opaque = NO;
  petWindow.backgroundColor = NSColor.clearColor;
  petWindow.hasShadow = NO;
  petWindow.releasedWhenClosed = NO;
  petWindow.level = NSFloatingWindowLevel;
  petWindow.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                 NSWindowCollectionBehaviorFullScreenAuxiliary |
                                 NSWindowCollectionBehaviorStationary;
  petWindow.delegate = self;
  petWindow.contentView = [[PetView alloc] initWithImage:image petName:petName codexUri:_codexUri size:size];
  [petWindow orderFrontRegardless];
  _window = petWindow;
  [self startSessionMonitor];
}

- (void)windowDidMove:(NSNotification *)notification {
  if (!_window) {
    return;
  }
  NSPoint origin = _window.frame.origin;
  [NSUserDefaults.standardUserDefaults setDouble:origin.x forKey:@"duotuanPetWindowX"];
  [NSUserDefaults.standardUserDefaults setDouble:origin.y forKey:@"duotuanPetWindowY"];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  [_sessionMonitorTimer invalidate];
  [_activeTaskReconcileTimer invalidate];
  [self cleanupPidFile];
}

- (void)quitPet:(id)sender {
  [self cleanupPidFile];
  [NSApp terminate:nil];
}

- (void)openCodex:(id)sender {
  if (_codexUri.length == 0) {
    return;
  }

  NSURL *url = [NSURL URLWithString:_codexUri];
  if (!url) {
    return;
  }

  [self clearActiveTasks];
  [self collapseBubble:nil];
  [NSWorkspace.sharedWorkspace openURL:url];
}

- (void)expandLatestBubble:(id)sender {
  if (_latestBubbleTitle.length == 0 && _latestBubbleBody.length == 0) {
    return;
  }

  [self showBubbleWithTitle:_latestBubbleTitle.length > 0 ? _latestBubbleTitle : @"Codex 提醒"
                        body:_latestBubbleBody.length > 0 ? _latestBubbleBody : @"点击打开查看。"];
}

- (void)toggleTaskBubble:(id)sender {
  if (_bubbleDisplayState == BubbleDisplayStateTaskList ||
      _bubbleDisplayState == BubbleDisplayStateTaskDetail) {
    [self collapseBubble:nil];
    return;
  }

  [self showTaskListBubble:sender];
}

- (void)showTaskListBubble:(id)sender {
  NSArray<NSString *> *taskKeys = [self orderedActiveTaskKeys];
  if (taskKeys.count == 0) {
    [self collapseBubble:nil];
    return;
  }

  [_bubbleTimer invalidate];
  _bubbleTimer = nil;
  [_bubbleWindow close];
  _bubbleWindow = nil;

  NSUInteger visibleCount = MIN((NSUInteger)4, taskKeys.count);
  CGFloat width = 424;
  CGFloat cardHeight = 86;
  CGFloat gap = 8;
  CGFloat height = (CGFloat)visibleCount * cardHeight + (CGFloat)(visibleCount - 1) * gap;
  NSRect frame = [self bubbleFrameForSize:NSMakeSize(width, height)];
  NSWindow *bubble = [[NSWindow alloc] initWithContentRect:frame
                                                  styleMask:NSWindowStyleMaskBorderless
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
  bubble.opaque = NO;
  bubble.backgroundColor = NSColor.clearColor;
  bubble.hasShadow = NO;
  bubble.releasedWhenClosed = NO;
  bubble.level = NSFloatingWindowLevel + 1;
  bubble.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                              NSWindowCollectionBehaviorFullScreenAuxiliary;

  NSView *content = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
  content.wantsLayer = YES;
  content.layer.backgroundColor = NSColor.clearColor.CGColor;

  for (NSUInteger index = 0; index < visibleCount; index++) {
    NSString *taskKey = taskKeys[index];
    NSDictionary *summary = [self taskSummaryForKey:taskKey];
    CGFloat y = height - cardHeight - (CGFloat)index * (cardHeight + gap);
    NSView *card = [[NSView alloc] initWithFrame:NSMakeRect(0, y, width, cardHeight)];
    card.wantsLayer = YES;
    card.layer.backgroundColor = NSColor.whiteColor.CGColor;
    card.layer.cornerRadius = 22;
    card.layer.masksToBounds = YES;
    [content addSubview:card];

    NSTextField *titleLabel = [NSTextField labelWithString:[self stringValue:summary[@"title"]]];
    titleLabel.frame = NSMakeRect(24, cardHeight - 36, width - 84, 24);
    titleLabel.font = [NSFont boldSystemFontOfSize:17];
    titleLabel.textColor = NSColor.blackColor;
    titleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
    [card addSubview:titleLabel];

    NSTextField *bodyLabel = [NSTextField labelWithString:[self stringValue:summary[@"body"]]];
    bodyLabel.frame = NSMakeRect(24, 15, width - 92, 38);
    bodyLabel.font = [NSFont systemFontOfSize:15];
    bodyLabel.textColor = NSColor.blackColor;
    bodyLabel.maximumNumberOfLines = 2;
    bodyLabel.lineBreakMode = NSLineBreakByTruncatingTail;
    [card addSubview:bodyLabel];

    TaskChevronButton *expandButton = [[TaskChevronButton alloc] initWithFrame:NSMakeRect(width - 54, cardHeight - 48, 38, 38)];
    expandButton.taskKey = taskKey;
    expandButton.target = self;
    expandButton.action = @selector(expandTaskBubble:);
    [card addSubview:expandButton];
  }

  bubble.contentView = content;
  [bubble orderFrontRegardless];
  _bubbleWindow = bubble;
  _bubbleDisplayState = BubbleDisplayStateTaskList;
  _bubbleTimer = [NSTimer scheduledTimerWithTimeInterval:12.0
                                                  target:self
                                                selector:@selector(collapseBubble:)
                                                userInfo:nil
                                                 repeats:NO];
}

- (void)expandTaskBubble:(id)sender {
  if (![sender isKindOfClass:TaskChevronButton.class]) {
    return;
  }

  TaskChevronButton *button = (TaskChevronButton *)sender;
  NSDictionary *summary = [self taskSummaryForKey:button.taskKey];
  if (!summary) {
    return;
  }

  [self showBubbleWithTitle:[self stringValue:summary[@"title"]]
                        body:[self stringValue:summary[@"body"]]
                        type:[self stringValue:summary[@"type"]]
                     taskKey:button.taskKey];
  _bubbleDisplayState = BubbleDisplayStateTaskDetail;
}

- (void)setCriticalNotificationMode:(id)sender {
  [self setNotificationMode:kNotificationModeCritical];
}

- (void)setProgressNotificationMode:(id)sender {
  [self setNotificationMode:kNotificationModeProgress];
}

- (void)setNotificationMode:(NSString *)mode {
  _notificationMode = [mode isEqualToString:kNotificationModeProgress] ? kNotificationModeProgress : kNotificationModeCritical;
  [NSUserDefaults.standardUserDefaults setObject:_notificationMode forKey:kNotificationModeDefaultsKey];
  NSString *title = [_notificationMode isEqualToString:kNotificationModeProgress] ? @"已切换为进度提醒" : @"已切换为关键提醒";
  NSString *body = [_notificationMode isEqualToString:kNotificationModeProgress]
    ? @"任务开始、进展、确认和完成都会提醒。"
    : @"只在需要你确认和任务完成时提醒。";
  [self showBubbleWithTitle:title body:body];
}

- (void)editPetSize:(id)sender {
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"编辑多多团团大小";
  alert.informativeText = @"拖动滑块后点保存。";
  [alert addButtonWithTitle:@"保存"];
  [alert addButtonWithTitle:@"取消"];

  NSView *accessory = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 280, 44)];
  NSSlider *slider = [[NSSlider alloc] initWithFrame:NSMakeRect(0, 8, 220, 24)];
  slider.minValue = 96;
  slider.maxValue = 280;
  slider.doubleValue = _petWidth;
  NSTextField *value = [[NSTextField alloc] initWithFrame:NSMakeRect(228, 8, 52, 24)];
  value.editable = NO;
  value.bezeled = NO;
  value.drawsBackground = NO;
  value.alignment = NSTextAlignmentRight;
  value.stringValue = [NSString stringWithFormat:@"%.0f", _petWidth];
  slider.target = self;
  slider.action = @selector(updateSizeSliderLabel:);
  slider.tag = 9042;
  value.tag = 9043;
  [accessory addSubview:slider];
  [accessory addSubview:value];
  alert.accessoryView = accessory;

  NSModalResponse response = [alert runModal];
  if (response == NSAlertFirstButtonReturn) {
    CGFloat width = round(slider.doubleValue);
    [self applyPetWidth:width save:YES];
  }
}

- (void)updateSizeSliderLabel:(NSSlider *)sender {
  NSTextField *value = (NSTextField *)[sender.superview viewWithTag:9043];
  value.stringValue = [NSString stringWithFormat:@"%.0f", round(sender.doubleValue)];
}

- (void)applyPetWidth:(CGFloat)width save:(BOOL)save {
  _petWidth = MIN(280, MAX(96, round(width)));
  NSSize newSize = [self petSizeForWidth:_petWidth];
  NSRect frame = _window.frame;
  frame.size = newSize;
  [_window setFrame:frame display:YES animate:NO];
  _window.contentView.needsDisplay = YES;
  if (save) {
    [NSUserDefaults.standardUserDefaults setDouble:_petWidth forKey:kPetSizeDefaultsKey];
    [self showBubbleWithTitle:@"大小已保存" body:[NSString stringWithFormat:@"当前宽度 %.0f px。", _petWidth]];
  }
}

- (BOOL)validateMenuItem:(NSMenuItem *)menuItem {
  if (menuItem.action == @selector(setCriticalNotificationMode:)) {
    menuItem.state = [_notificationMode isEqualToString:kNotificationModeCritical] ? NSControlStateValueOn : NSControlStateValueOff;
  } else if (menuItem.action == @selector(setProgressNotificationMode:)) {
    menuItem.state = [_notificationMode isEqualToString:kNotificationModeProgress] ? NSControlStateValueOn : NSControlStateValueOff;
  }
  return YES;
}

- (void)startSessionMonitor {
  _eventLogPath = [_codexHomePath stringByAppendingPathComponent:@"duotuan-pet-events.jsonl"];
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:_eventLogPath error:nil];
  _eventLogOffset = [attributes[NSFileSize] unsignedLongLongValue];
  [self seedActiveTasksFromEventLog];
  [self pollSessionMonitors:nil];
  [self reconcileActiveTasksWithSessionFiles:nil];
  _sessionMonitorTimer = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                          target:self
                                                        selector:@selector(pollSessionMonitors:)
                                                        userInfo:nil
                                                         repeats:YES];
  _activeTaskReconcileTimer = [NSTimer scheduledTimerWithTimeInterval:kActiveTaskReconcileInterval
                                                               target:self
                                                             selector:@selector(reconcileActiveTasksWithSessionFiles:)
                                                             userInfo:nil
                                                              repeats:YES];
}

- (void)pollSessionMonitors:(NSTimer *)timer {
  [self pollPetEventLog:timer];
  [self pollCodexSessions:timer];
}

- (void)seedActiveTasksFromEventLog {
  NSData *data = [NSData dataWithContentsOfFile:_eventLogPath];
  if (data.length == 0) {
    return;
  }

  NSUInteger maxBytes = 256 * 1024;
  if (data.length > maxBytes) {
    data = [data subdataWithRange:NSMakeRange(data.length - maxBytes, maxBytes)];
  }

  NSString *source = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  NSArray<NSString *> *lines = [source componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
  NSDate *oldestInterestingDate = [[NSDate date] dateByAddingTimeInterval:-6 * 60 * 60];

  for (NSString *line in lines) {
    if (line.length == 0) {
      continue;
    }
    NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
    if (![event isKindOfClass:NSDictionary.class]) {
      continue;
    }

    NSDate *emittedAt = [self dateFromCodexTimestamp:[self stringValue:event[@"emittedAt"]]];
    if (emittedAt && [emittedAt compare:oldestInterestingDate] == NSOrderedAscending) {
      continue;
    }

    NSString *type = [self stringValue:event[@"type"]];
    if (!([type isEqualToString:@"started"] ||
          [type isEqualToString:@"progress"] ||
          [type isEqualToString:@"needs_approval"] ||
          [type isEqualToString:@"completed"] ||
          [type isEqualToString:@"failed"])) {
      continue;
    }

    NSString *title = [self stringValue:event[@"title"]];
    NSString *body = [self stringValue:event[@"body"]];
    NSString *taskKey = [self taskKeyForEvent:event];
    [self syncActiveTaskKey:taskKey
        forNotificationType:type
                     title:title.length > 0 ? title : @"Codex 提醒"
                      body:body.length > 0 ? body : @"点击打开查看。"
                 updatedAt:emittedAt];
  }
  [self pruneStaleActiveTasks];
}

- (void)pollPetEventLog:(NSTimer *)timer {
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:_eventLogPath error:nil];
  unsigned long long fileSize = [attributes[NSFileSize] unsignedLongLongValue];
  if (fileSize <= _eventLogOffset) {
    return;
  }

  NSFileHandle *handle = [NSFileHandle fileHandleForReadingAtPath:_eventLogPath];
  if (!handle) {
    return;
  }

  @try {
    [handle seekToFileOffset:_eventLogOffset];
    NSData *data = [handle readDataToEndOfFile];
    [handle closeFile];
    _eventLogOffset += data.length;
    NSString *source = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSArray<NSString *> *lines = [source componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
    for (NSString *line in lines) {
      if (line.length == 0) {
        continue;
      }
      NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
      NSDictionary *event = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
      if ([event isKindOfClass:NSDictionary.class]) {
        [self handlePetNotificationEvent:event];
      }
    }
  } @catch (NSException *exception) {
    _eventLogOffset = fileSize;
  }
}

- (void)handlePetNotificationEvent:(NSDictionary *)event {
  NSString *eventId = [self stringValue:event[@"id"]];
  if (![self markEventKeyIfNeeded:eventId]) {
    return;
  }

  NSString *type = [self stringValue:event[@"type"]];
  NSString *title = [self stringValue:event[@"title"]];
  NSString *body = [self stringValue:event[@"body"]];
  NSString *taskKey = [self taskKeyForEvent:event];
  [self syncActiveTaskKey:taskKey
      forNotificationType:type
                   title:title.length > 0 ? title : @"Codex 提醒"
                    body:body.length > 0 ? body : @"点击打开查看。"];

  if (![_notificationMode isEqualToString:kNotificationModeProgress] &&
      ([type isEqualToString:@"started"] || [type isEqualToString:@"progress"])) {
    return;
  }

  [self showBubbleWithTitle:title.length > 0 ? title : @"Codex 提醒"
                        body:body.length > 0 ? body : @"点击打开查看。"
                        type:type
                     taskKey:taskKey];
}

- (NSString *)taskKeyForEvent:(NSDictionary *)event {
  NSString *eventTitle = [self taskTitleFromNotificationTitle:[self stringValue:event[@"title"]]];
  NSString *taskKey = [self stringValue:event[@"taskKey"]];
  if (taskKey.length > 0) {
    if (eventTitle.length > 0) {
      _legacyTaskKeysByTitle[eventTitle] = taskKey;
    }
    return taskKey;
  }

  NSString *eventId = [self stringValue:event[@"id"]];
  if (eventId.length == 0) {
    return @"";
  }

  NSString *derivedTaskKey = eventId;
  NSArray<NSString *> *suffixes = @[
    @":needs-approval:",
    @":started",
    @":progress:",
    @":complete",
    @":completed",
    @":failed"
  ];
  for (NSString *suffix in suffixes) {
    NSRange range = [eventId rangeOfString:suffix options:NSBackwardsSearch];
    if (range.location != NSNotFound && range.location > 0) {
      derivedTaskKey = [eventId substringToIndex:range.location];
      break;
    }
  }

  NSString *knownTaskKey = eventTitle.length > 0 ? _legacyTaskKeysByTitle[eventTitle] : nil;
  BOOL knownIsFilePath = [knownTaskKey containsString:@"/"];
  BOOL derivedIsTurnId = derivedTaskKey.length > 0 && ![derivedTaskKey containsString:@"/"];
  if (knownTaskKey.length > 0 && !(knownIsFilePath && derivedIsTurnId)) {
    return knownTaskKey;
  }

  if (eventTitle.length > 0 && derivedTaskKey.length > 0) {
    _legacyTaskKeysByTitle[eventTitle] = derivedTaskKey;
  }
  return derivedTaskKey;
}

- (NSString *)taskTitleFromNotificationTitle:(NSString *)title {
  NSString *taskTitle = [self cleanedSingleLine:title];
  NSArray<NSString *> *suffixes = @[
    @" 需要你同意",
    @" 已开始执行",
    @" 有新进度",
    @" 已经完成作业",
    @" 已经完成",
    @" 失败"
  ];
  for (NSString *suffix in suffixes) {
    if ([taskTitle hasSuffix:suffix]) {
      return [taskTitle substringToIndex:taskTitle.length - suffix.length];
    }
  }
  return taskTitle;
}

- (void)pollCodexSessions:(NSTimer *)timer {
  NSString *sessionsPath = [_codexHomePath stringByAppendingPathComponent:@"sessions"];
  NSFileManager *fileManager = NSFileManager.defaultManager;
  NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtPath:sessionsPath];
  NSString *entry = nil;
  NSDate *oldestInterestingDate = [_monitorStartedAt dateByAddingTimeInterval:-10.0];

  while ((entry = [enumerator nextObject])) {
    if (![entry.pathExtension isEqualToString:@"jsonl"]) {
      continue;
    }

    NSString *filePath = [sessionsPath stringByAppendingPathComponent:entry];
    NSDictionary *attributes = [fileManager attributesOfItemAtPath:filePath error:nil];
    NSDate *modifiedAt = attributes[NSFileModificationDate];
    unsigned long long fileSize = [attributes[NSFileSize] unsignedLongLongValue];
    NSNumber *offsetNumber = _fileOffsets[filePath];

    if (!offsetNumber && modifiedAt && [modifiedAt compare:oldestInterestingDate] == NSOrderedAscending) {
      _fileOffsets[filePath] = @(fileSize);
      continue;
    }

    unsigned long long offset = offsetNumber ? offsetNumber.unsignedLongLongValue : 0;
    if (fileSize <= offset) {
      continue;
    }

    [self processCodexSessionFile:filePath fromOffset:offset fileSize:fileSize];
  }
}

- (void)reconcileActiveTasksWithSessionFiles:(NSTimer *)timer {
  if (_reconcileInFlight) {
    return;
  }

  _reconcileInFlight = YES;
  dispatch_async(_activeTaskReconcileQueue, ^{
    NSDictionary<NSString *, NSDictionary *> *summaries = [self activeTaskSummariesFromRecentSessions];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (summaries) {
        [self replaceActiveTasksWithSummaries:summaries];
      } else {
        [self pruneStaleActiveTasks];
      }
      _reconcileInFlight = NO;
    });
  });
}

- (NSDictionary<NSString *, NSDictionary *> *)activeTaskSummariesFromRecentSessions {
  NSString *sessionsPath = [_codexHomePath stringByAppendingPathComponent:@"sessions"];
  NSFileManager *fileManager = NSFileManager.defaultManager;
  BOOL isDirectory = NO;
  if (![fileManager fileExistsAtPath:sessionsPath isDirectory:&isDirectory] || !isDirectory) {
    return nil;
  }

  NSMutableDictionary<NSString *, NSDictionary *> *summaries = [NSMutableDictionary dictionary];
  NSMutableSet<NSString *> *seenFilePaths = [NSMutableSet set];
  NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtPath:sessionsPath];
  NSDate *oldestInterestingDate = [[NSDate date] dateByAddingTimeInterval:-kActiveTaskStaleInterval];
  NSString *entry = nil;
  while ((entry = [enumerator nextObject])) {
    if (![entry.pathExtension isEqualToString:@"jsonl"]) {
      continue;
    }

    NSString *filePath = [sessionsPath stringByAppendingPathComponent:entry];
    NSDictionary *attributes = [fileManager attributesOfItemAtPath:filePath error:nil];
    NSDate *modifiedAt = attributes[NSFileModificationDate];
    unsigned long long fileSize = [attributes[NSFileSize] unsignedLongLongValue];
    if (modifiedAt && [modifiedAt compare:oldestInterestingDate] == NSOrderedAscending) {
      [_sessionSummaryCache removeObjectForKey:filePath];
      continue;
    }
    [seenFilePaths addObject:filePath];

    NSDictionary *cacheEntry = _sessionSummaryCache[filePath];
    NSDate *cachedModifiedAt = [cacheEntry isKindOfClass:NSDictionary.class] ? cacheEntry[@"modifiedAt"] : nil;
    NSNumber *cachedFileSize = [cacheEntry isKindOfClass:NSDictionary.class] ? cacheEntry[@"fileSize"] : nil;
    BOOL cacheMatches = [cachedModifiedAt isKindOfClass:NSDate.class] &&
                        [cachedFileSize isKindOfClass:NSNumber.class] &&
                        [cachedModifiedAt isEqualToDate:(modifiedAt ?: NSDate.distantPast)] &&
                        cachedFileSize.unsignedLongLongValue == fileSize;

    NSDictionary *summary = nil;
    if (cacheMatches) {
      id cachedSummary = cacheEntry[@"summary"];
      if ([cachedSummary isKindOfClass:NSDictionary.class]) {
        summary = cachedSummary;
      }
    } else {
      summary = [self activeTaskSummaryForSessionFile:filePath
                                           modifiedAt:modifiedAt
                                oldestInterestingDate:oldestInterestingDate];
      _sessionSummaryCache[filePath] = @{
        @"modifiedAt": modifiedAt ?: NSDate.distantPast,
        @"fileSize": @(fileSize),
        @"summary": summary ?: (id)NSNull.null
      };
    }

    NSString *taskKey = [self stringValue:summary[@"taskKey"]];
    if (taskKey.length > 0) {
      summaries[taskKey] = summary;
    }
  }

  for (NSString *cachedPath in _sessionSummaryCache.allKeys) {
    if (![seenFilePaths containsObject:cachedPath]) {
      [_sessionSummaryCache removeObjectForKey:cachedPath];
    }
  }
  return summaries;
}

- (NSDictionary *)activeTaskSummaryForSessionFile:(NSString *)filePath
                                       modifiedAt:(NSDate *)modifiedAt
                            oldestInterestingDate:(NSDate *)oldestInterestingDate {
  NSData *data = [NSData dataWithContentsOfFile:filePath];
  if (data.length == 0) {
    return nil;
  }

  NSString *source = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  NSArray<NSString *> *lines = [source componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
  NSString *taskKey = filePath;
  NSString *sessionTitle = @"";
  NSString *firstMessage = @"";
  NSString *latestBody = @"Codex 正在处理这个任务。";
  NSString *latestType = @"";
  NSDate *latestUpdatedAt = modifiedAt ?: [NSDate date];
  BOOL sawTaskLifecycle = NO;
  BOOL active = NO;

  for (NSString *line in lines) {
    if (line.length == 0) {
      continue;
    }
    NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
    if (![event isKindOfClass:NSDictionary.class]) {
      continue;
    }

    NSDictionary *payload = event[@"payload"];
    if (![payload isKindOfClass:NSDictionary.class]) {
      continue;
    }

    NSDate *eventDate = [self dateFromCodexTimestamp:[self stringValue:event[@"timestamp"]]];
    if (!eventDate) {
      eventDate = [self dateFromCodexTimestamp:[self stringValue:payload[@"timestamp"]]];
    }

    NSString *rawTurnId = [self stringValue:payload[@"turn_id"]];
    if (rawTurnId.length > 0) {
      taskKey = rawTurnId;
    }

    NSString *payloadType = [self stringValue:payload[@"type"]];
    if ([payloadType isEqualToString:@"thread_name_updated"]) {
      NSString *threadName = [self cleanedSingleLine:[self stringValue:payload[@"thread_name"]]];
      if (threadName.length > 0) {
        sessionTitle = threadName;
      }
      continue;
    }

    if ([payloadType isEqualToString:@"user_message"] && firstMessage.length == 0) {
      NSString *message = [self cleanedSingleLine:[self stringValue:payload[@"message"]]];
      if (message.length > 0) {
        firstMessage = message;
      }
      continue;
    }

    if ([payloadType isEqualToString:@"task_started"]) {
      sawTaskLifecycle = YES;
      active = YES;
      latestType = @"started";
      latestBody = @"Codex 正在处理这个任务。";
      latestUpdatedAt = eventDate ?: latestUpdatedAt;
      continue;
    }

    if ([self payloadLooksLikeNeedsApproval:payload]) {
      sawTaskLifecycle = YES;
      active = YES;
      latestType = @"needs_approval";
      latestBody = [self approvalBodyFromPayload:payload];
      latestUpdatedAt = eventDate ?: latestUpdatedAt;
      continue;
    }

    if ([payloadType isEqualToString:@"agent_message"] && sawTaskLifecycle && active) {
      NSString *message = [self cleanedSingleLine:[self stringValue:payload[@"message"]]];
      latestType = @"progress";
      latestBody = message.length > 0 ? [self truncate:message maxLength:72] : @"Codex 有新的执行进展。";
      latestUpdatedAt = eventDate ?: latestUpdatedAt;
      continue;
    }

    if ([payloadType isEqualToString:@"task_complete"] ||
        [payloadType isEqualToString:@"task_completed"] ||
        [payloadType isEqualToString:@"turn_complete"]) {
      sawTaskLifecycle = YES;
      active = NO;
      latestType = @"completed";
      latestUpdatedAt = eventDate ?: latestUpdatedAt;
      continue;
    }
  }

  if (!active || latestType.length == 0) {
    return nil;
  }

  NSDate *oldestLiveDate = [[NSDate date] dateByAddingTimeInterval:-kActiveTaskStaleInterval];
  if (latestUpdatedAt && [latestUpdatedAt compare:oldestLiveDate] == NSOrderedAscending) {
    return nil;
  }
  if (latestUpdatedAt && [latestUpdatedAt compare:oldestInterestingDate] == NSOrderedAscending) {
    return nil;
  }

  NSString *taskTitle = [self taskTitleFromSessionTitle:sessionTitle firstMessage:firstMessage];
  NSString *suffix = @"有新进度";
  if ([latestType isEqualToString:@"started"]) {
    suffix = @"已开始执行";
  } else if ([latestType isEqualToString:@"needs_approval"]) {
    suffix = @"需要你同意";
  }

  return @{
    @"taskKey": taskKey,
    @"title": [NSString stringWithFormat:@"%@ %@", taskTitle, suffix],
    @"body": latestBody.length > 0 ? latestBody : @"点击打开查看。",
    @"type": latestType,
    @"updatedAt": latestUpdatedAt ?: [NSDate date]
  };
}

- (void)processCodexSessionFile:(NSString *)filePath fromOffset:(unsigned long long)offset fileSize:(unsigned long long)fileSize {
  NSFileHandle *handle = [NSFileHandle fileHandleForReadingAtPath:filePath];
  if (!handle) {
    return;
  }

  @try {
    [handle seekToFileOffset:offset];
    NSData *data = [handle readDataToEndOfFile];
    _fileOffsets[filePath] = @(offset + data.length);
    NSString *source = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSArray<NSString *> *lines = [source componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
    for (NSString *line in lines) {
      if (line.length == 0) {
        continue;
      }
      NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
      NSDictionary *event = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
      if ([event isKindOfClass:NSDictionary.class]) {
        [self handleCodexEvent:event filePath:filePath];
      }
    }
  } @catch (NSException *exception) {
    _fileOffsets[filePath] = @(fileSize);
  }
}

- (void)handleCodexEvent:(NSDictionary *)event filePath:(NSString *)filePath {
  NSDictionary *payload = event[@"payload"];
  if (![payload isKindOfClass:NSDictionary.class]) {
    return;
  }

  NSString *outerType = [self stringValue:event[@"type"]];
  NSString *payloadType = [self stringValue:payload[@"type"]];
  NSString *rawTurnId = [self stringValue:payload[@"turn_id"]];
  if (rawTurnId.length > 0) {
    _fileTaskKeys[filePath] = rawTurnId;
  }
  NSString *turnId = _fileTaskKeys[filePath];
  if (turnId.length == 0) {
    turnId = [filePath lastPathComponent];
    _fileTaskKeys[filePath] = turnId;
  }

  if ([payloadType isEqualToString:@"thread_name_updated"]) {
    NSString *threadName = [self cleanedSingleLine:[self stringValue:payload[@"thread_name"]]];
    if (threadName.length > 0) {
      _fileTitles[filePath] = threadName;
    }
    return;
  }

  if ([payloadType isEqualToString:@"user_message"] && !_fileFirstMessages[filePath]) {
    NSString *message = [self cleanedSingleLine:[self stringValue:payload[@"message"]]];
    if (message.length > 0) {
      _fileFirstMessages[filePath] = [self truncate:message maxLength:28];
    }
    return;
  }

  if (![self isFreshEvent:event]) {
    return;
  }

  if ([outerType isEqualToString:@"response_item"] && [self payloadLooksLikeNeedsApproval:payload]) {
    NSString *key = [NSString stringWithFormat:@"%@:needs-approval:%@", turnId, [self stringValue:payload[@"call_id"]]];
    if ([self markEventKeyIfNeeded:key]) {
      NSString *taskTitle = [self taskTitleForFile:filePath];
      [self showBubbleWithTitle:[NSString stringWithFormat:@"%@ 需要你同意", taskTitle]
                            body:[self approvalBodyFromPayload:payload]
                            type:@"needs_approval"
                         taskKey:turnId];
    }
    return;
  }

  if ([payloadType isEqualToString:@"task_started"]) {
    NSString *taskTitle = [self taskTitleForFile:filePath];
    NSString *title = [NSString stringWithFormat:@"%@ 已开始执行", taskTitle];
    NSString *body = @"Codex 正在处理这个任务。";
    [self syncActiveTaskKey:turnId
        forNotificationType:@"started"
                     title:title
                      body:body];

    if ([self isProgressMode]) {
      NSString *key = [NSString stringWithFormat:@"%@:started", turnId];
      if ([self markEventKeyIfNeeded:key]) {
        [self showBubbleWithTitle:title
                              body:body
                              type:@"started"
                           taskKey:turnId];
      }
    }
    return;
  }

  if ([payloadType isEqualToString:@"agent_message"]) {
    NSString *taskTitle = [self taskTitleForFile:filePath];
    NSString *message = [self cleanedSingleLine:[self stringValue:payload[@"message"]]];
    if (message.length == 0) {
      message = @"Codex 有新的执行进展。";
    }
    NSString *title = [NSString stringWithFormat:@"%@ 有新进度", taskTitle];
    NSString *body = [self truncate:message maxLength:72];
    [self syncActiveTaskKey:turnId
        forNotificationType:@"progress"
                     title:title
                      body:body];

    if ([self isProgressMode] && [self shouldShowProgressForTurn:turnId]) {
      [self showBubbleWithTitle:title
                            body:body
                            type:@"progress"
                         taskKey:turnId];
    }
    return;
  }

  if ([payloadType isEqualToString:@"task_complete"]) {
    [self syncActiveTaskKey:turnId forNotificationType:@"completed"];

    NSString *key = [NSString stringWithFormat:@"%@:complete", turnId];
    if ([self markEventKeyIfNeeded:key]) {
      NSString *taskTitle = [self taskTitleForFile:filePath];
      NSString *message = [self cleanedSingleLine:[self stringValue:payload[@"last_agent_message"]]];
      [self showBubbleWithTitle:[NSString stringWithFormat:@"%@ 已经完成作业", taskTitle]
                            body:message.length > 0 ? [self truncate:message maxLength:78] : @"点击打开 Codex 查看结果。"
                            type:@"completed"
                         taskKey:turnId];
    }
  }
}

- (BOOL)payloadLooksLikeNeedsApproval:(NSDictionary *)payload {
  NSString *payloadType = [self stringValue:payload[@"type"]];
  if (!([payloadType isEqualToString:@"function_call"] || [payloadType isEqualToString:@"custom_tool_call"])) {
    return NO;
  }

  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  NSString *source = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
  NSArray<NSString *> *needles = @[
    @"\"sandbox_permissions\":\"require_escalated\"",
    @"request_user_input",
    @"requestUserInput",
    @"approval_request",
    @"permission_request",
    @"request_plugin_install"
  ];
  for (NSString *needle in needles) {
    if ([source containsString:needle]) {
      return YES;
    }
  }
  return NO;
}

- (NSString *)approvalBodyFromPayload:(NSDictionary *)payload {
  id arguments = payload[@"arguments"];
  NSDictionary *argumentDictionary = nil;
  if ([arguments isKindOfClass:NSDictionary.class]) {
    argumentDictionary = arguments;
  } else if ([arguments isKindOfClass:NSString.class]) {
    NSData *data = [(NSString *)arguments dataUsingEncoding:NSUTF8StringEncoding];
    id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if ([parsed isKindOfClass:NSDictionary.class]) {
      argumentDictionary = parsed;
    }
  }

  NSString *justification = [self cleanedSingleLine:[self stringValue:argumentDictionary[@"justification"]]];
  if (justification.length > 0) {
    return [self truncate:justification maxLength:84];
  }
  return @"Codex 正在等待你确认，点击打开处理。";
}

- (BOOL)isFreshEvent:(NSDictionary *)event {
  NSDate *eventDate = [self dateFromCodexTimestamp:[self stringValue:event[@"timestamp"]]];
  if (!eventDate) {
    return YES;
  }
  return [eventDate compare:[_monitorStartedAt dateByAddingTimeInterval:-3.0]] != NSOrderedAscending;
}

- (BOOL)markEventKeyIfNeeded:(NSString *)key {
  if (key.length == 0 || [_seenEventKeys containsObject:key]) {
    return NO;
  }
  [_seenEventKeys addObject:key];
  return YES;
}

- (BOOL)shouldShowProgressForTurn:(NSString *)turnId {
  NSDate *now = [NSDate date];
  NSDate *last = _lastProgressByTurn[turnId];
  if (last && [now timeIntervalSinceDate:last] < 45.0) {
    return NO;
  }
  _lastProgressByTurn[turnId] = now;
  return YES;
}

- (BOOL)isProgressMode {
  return [_notificationMode isEqualToString:kNotificationModeProgress];
}

- (NSString *)taskTitleForFile:(NSString *)filePath {
  NSString *title = _fileTitles[filePath];
  if (title.length == 0) {
    title = _fileFirstMessages[filePath];
  }
  if (title.length == 0) {
    title = @"Codex 任务";
  }
  return [self truncate:title maxLength:26];
}

- (NSString *)taskTitleFromSessionTitle:(NSString *)sessionTitle firstMessage:(NSString *)firstMessage {
  NSString *title = [self cleanedSingleLine:sessionTitle];
  if (title.length == 0) {
    title = [self cleanedSingleLine:firstMessage];
  }
  if (title.length == 0) {
    title = @"Codex 任务";
  }
  return [self truncate:title maxLength:26];
}

- (void)showBubbleWithTitle:(NSString *)title body:(NSString *)body {
  [self showBubbleWithTitle:title body:body type:nil taskKey:nil];
}

- (void)showBubbleWithTitle:(NSString *)title body:(NSString *)body type:(NSString *)type taskKey:(NSString *)taskKey {
  [_bubbleTimer invalidate];
  _bubbleTimer = nil;
  [_bubbleWindow close];
  _bubbleWindow = nil;

  _latestBubbleTitle = [title ?: @"Codex 提醒" copy];
  _latestBubbleBody = [body ?: @"点击打开查看。" copy];
  [self syncActiveTaskKey:taskKey
      forNotificationType:type
                   title:_latestBubbleTitle
                    body:_latestBubbleBody];
  [self applyAnimationStateForNotificationType:type];

  CGFloat width = 424;
  CGFloat height = 132;
  NSRect frame = [self bubbleFrameForSize:NSMakeSize(width, height)];
  NSWindow *bubble = [[NSWindow alloc] initWithContentRect:frame
                                                  styleMask:NSWindowStyleMaskBorderless
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
  bubble.opaque = NO;
  bubble.backgroundColor = NSColor.clearColor;
  bubble.hasShadow = YES;
  bubble.releasedWhenClosed = NO;
  bubble.level = NSFloatingWindowLevel + 1;
  bubble.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                              NSWindowCollectionBehaviorFullScreenAuxiliary;

  DraggableBubbleView *content = [[DraggableBubbleView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
  content.wantsLayer = YES;
  content.layer.backgroundColor = NSColor.whiteColor.CGColor;
  content.layer.cornerRadius = 28;
  content.layer.masksToBounds = YES;

  NSTextField *titleLabel = [NSTextField labelWithString:_latestBubbleTitle];
  titleLabel.frame = NSMakeRect(26, height - 44, width - 92, 26);
  titleLabel.font = [NSFont boldSystemFontOfSize:18];
  titleLabel.textColor = NSColor.blackColor;
  titleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
  [content addSubview:titleLabel];

  NSTextField *bodyLabel = [NSTextField labelWithString:_latestBubbleBody];
  bodyLabel.frame = NSMakeRect(26, 54, width - 92, 44);
  bodyLabel.font = [NSFont systemFontOfSize:16];
  bodyLabel.textColor = NSColor.blackColor;
  bodyLabel.maximumNumberOfLines = 2;
  bodyLabel.lineBreakMode = NSLineBreakByTruncatingTail;
  [content addSubview:bodyLabel];

  NSButton *collapseButton = [NSButton buttonWithTitle:@"⌄" target:self action:@selector(collapseBubble:)];
  collapseButton.frame = NSMakeRect(width - 46, height - 42, 30, 30);
  collapseButton.bordered = NO;
  collapseButton.wantsLayer = YES;
  collapseButton.layer.backgroundColor = [NSColor colorWithWhite:0 alpha:0.08].CGColor;
  collapseButton.layer.cornerRadius = 15;
  collapseButton.font = [NSFont systemFontOfSize:18 weight:NSFontWeightSemibold];
  collapseButton.contentTintColor = NSColor.blackColor;
  [collapseButton setToolTip:@"折叠提醒"];
  [collapseButton setAccessibilityLabel:@"折叠提醒"];
  [content addSubview:collapseButton];

  NSButton *button = [NSButton buttonWithTitle:@"打开处理" target:self action:@selector(openCodex:)];
  button.frame = NSMakeRect(width - 126, 18, 96, 30);
  button.bezelStyle = NSBezelStyleRounded;
  [content addSubview:button];

  bubble.contentView = content;
  [bubble orderFrontRegardless];
  _bubbleWindow = bubble;
  _bubbleDisplayState = BubbleDisplayStateGeneric;
  _bubbleTimer = [NSTimer scheduledTimerWithTimeInterval:12.0
                                                  target:self
                                                selector:@selector(collapseBubble:)
                                                userInfo:nil
                                                 repeats:NO];
}

- (void)collapseBubble:(id)sender {
  [_bubbleTimer invalidate];
  [_bubbleWindow close];
  _bubbleWindow = nil;
  _bubbleTimer = nil;
  _bubbleDisplayState = BubbleDisplayStateNone;
}

- (NSArray<NSString *> *)orderedActiveTaskKeys {
  NSMutableArray<NSString *> *ordered = [NSMutableArray array];
  NSEnumerator<NSString *> *reverseEnumerator = [_activeTaskOrder reverseObjectEnumerator];
  NSString *taskKey = nil;
  while ((taskKey = [reverseEnumerator nextObject])) {
    if ([_activeTaskKeys containsObject:taskKey] && ![ordered containsObject:taskKey]) {
      [ordered addObject:taskKey];
    }
  }

  for (NSString *key in _activeTaskKeys) {
    if (![ordered containsObject:key]) {
      [ordered addObject:key];
    }
  }
  return ordered;
}

- (NSDictionary *)taskSummaryForKey:(NSString *)taskKey {
  NSDictionary *summary = _activeTaskSummaries[taskKey];
  if ([summary isKindOfClass:NSDictionary.class]) {
    return summary;
  }
  return @{
    @"title": _latestBubbleTitle.length > 0 ? _latestBubbleTitle : @"Codex 提醒",
    @"body": _latestBubbleBody.length > 0 ? _latestBubbleBody : @"点击打开查看。",
    @"type": @""
  };
}

- (void)syncActiveTaskKey:(NSString *)taskKey forNotificationType:(NSString *)type {
  [self syncActiveTaskKey:taskKey forNotificationType:type title:nil body:nil];
}

- (void)syncActiveTaskKey:(NSString *)taskKey forNotificationType:(NSString *)type title:(NSString *)title body:(NSString *)body {
  [self syncActiveTaskKey:taskKey forNotificationType:type title:title body:body updatedAt:nil];
}

- (void)syncActiveTaskKey:(NSString *)taskKey
      forNotificationType:(NSString *)type
                    title:(NSString *)title
                     body:(NSString *)body
                updatedAt:(NSDate *)updatedAt {
  if (taskKey.length == 0 || type.length == 0) {
    return;
  }

  if ([type isEqualToString:@"started"] ||
      [type isEqualToString:@"progress"] ||
      [type isEqualToString:@"needs_approval"]) {
    [_activeTaskKeys addObject:taskKey];
    [_activeTaskOrder removeObject:taskKey];
    [_activeTaskOrder addObject:taskKey];
    _activeTaskLastUpdatedAt[taskKey] = updatedAt ?: [NSDate date];
    [_activeTaskSummaries setObject:@{
      @"title": title.length > 0 ? title : @"Codex 提醒",
      @"body": body.length > 0 ? body : @"点击打开查看。",
      @"type": type
    } forKey:taskKey];
  } else if ([type isEqualToString:@"completed"] ||
             [type isEqualToString:@"failed"]) {
    [_activeTaskKeys removeObject:taskKey];
    [_activeTaskOrder removeObject:taskKey];
    [_activeTaskSummaries removeObjectForKey:taskKey];
    [_activeTaskLastUpdatedAt removeObjectForKey:taskKey];
  }
  [self updatePetBadge];
}

- (void)clearActiveTasks {
  [_activeTaskKeys removeAllObjects];
  [_activeTaskOrder removeAllObjects];
  [_activeTaskSummaries removeAllObjects];
  [_activeTaskLastUpdatedAt removeAllObjects];
  [self updatePetBadge];
  [self setPetAnimationState:PetAnimationStateIdle];
}

- (void)pruneStaleActiveTasks {
  NSDate *oldestLiveDate = [[NSDate date] dateByAddingTimeInterval:-kActiveTaskStaleInterval];
  NSMutableArray<NSString *> *staleTaskKeys = [NSMutableArray array];
  for (NSString *taskKey in _activeTaskKeys) {
    NSDate *updatedAt = _activeTaskLastUpdatedAt[taskKey];
    if (updatedAt && [updatedAt compare:oldestLiveDate] == NSOrderedAscending) {
      [staleTaskKeys addObject:taskKey];
    }
  }

  if (staleTaskKeys.count == 0) {
    return;
  }

  for (NSString *taskKey in staleTaskKeys) {
    [_activeTaskKeys removeObject:taskKey];
    [_activeTaskOrder removeObject:taskKey];
    [_activeTaskSummaries removeObjectForKey:taskKey];
    [_activeTaskLastUpdatedAt removeObjectForKey:taskKey];
  }
  [self updatePetBadge];
  if (_activeTaskKeys.count == 0) {
    [self setPetAnimationState:PetAnimationStateIdle];
  }
}

- (BOOL)activeTaskSnapshotMatchesCurrentState:(NSDictionary<NSString *, NSDictionary *> *)summaries {
  if (summaries.count != _activeTaskKeys.count) {
    return NO;
  }

  for (NSString *taskKey in summaries) {
    if (![_activeTaskKeys containsObject:taskKey]) {
      return NO;
    }

    NSDictionary *incoming = summaries[taskKey];
    NSDictionary *current = _activeTaskSummaries[taskKey];
    if (![incoming isKindOfClass:NSDictionary.class] || ![current isKindOfClass:NSDictionary.class]) {
      return NO;
    }

    NSArray<NSString *> *fields = @[@"title", @"body", @"type"];
    for (NSString *field in fields) {
      NSString *incomingValue = [self stringValue:incoming[field]];
      NSString *currentValue = [self stringValue:current[field]];
      if (![incomingValue isEqualToString:currentValue]) {
        return NO;
      }
    }
  }

  return YES;
}

- (void)replaceActiveTasksWithSummaries:(NSDictionary<NSString *, NSDictionary *> *)summaries {
  if ([self activeTaskSnapshotMatchesCurrentState:summaries]) {
    return;
  }

  [_activeTaskKeys removeAllObjects];
  [_activeTaskOrder removeAllObjects];
  [_activeTaskSummaries removeAllObjects];
  [_activeTaskLastUpdatedAt removeAllObjects];

  NSArray<NSString *> *taskKeys = [summaries keysSortedByValueUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    NSDate *leftDate = [left isKindOfClass:NSDictionary.class] ? left[@"updatedAt"] : nil;
    NSDate *rightDate = [right isKindOfClass:NSDictionary.class] ? right[@"updatedAt"] : nil;
    if (![leftDate isKindOfClass:NSDate.class]) {
      leftDate = NSDate.distantPast;
    }
    if (![rightDate isKindOfClass:NSDate.class]) {
      rightDate = NSDate.distantPast;
    }
    return [leftDate compare:rightDate];
  }];

  for (NSString *taskKey in taskKeys) {
    NSDictionary *summary = summaries[taskKey];
    if (![summary isKindOfClass:NSDictionary.class]) {
      continue;
    }
    [_activeTaskKeys addObject:taskKey];
    [_activeTaskOrder addObject:taskKey];
    _activeTaskSummaries[taskKey] = summary;
    NSDate *updatedAt = summary[@"updatedAt"];
    if ([updatedAt isKindOfClass:NSDate.class]) {
      _activeTaskLastUpdatedAt[taskKey] = updatedAt;
    }
  }

  [self updatePetBadge];
  if (_activeTaskKeys.count == 0) {
    [self setPetAnimationState:PetAnimationStateIdle];
    return;
  }

  NSString *latestTaskKey = _activeTaskOrder.lastObject;
  NSDictionary *latestSummary = latestTaskKey.length > 0 ? _activeTaskSummaries[latestTaskKey] : nil;
  [self applyAnimationStateForNotificationType:[self stringValue:latestSummary[@"type"]]];
}

- (void)updatePetBadge {
  PetView *petView = (PetView *)_window.contentView;
  [petView setBadgeCount:_activeTaskKeys.count];
}

- (void)applyAnimationStateForNotificationType:(NSString *)type {
  if ([type isEqualToString:@"started"] || [type isEqualToString:@"progress"]) {
    [self setPetAnimationState:PetAnimationStateRunning];
  } else if ([type isEqualToString:@"needs_approval"]) {
    [self setPetAnimationState:PetAnimationStateWaiting];
  } else if ([type isEqualToString:@"completed"]) {
    [self setPetAnimationState:PetAnimationStateReview];
  } else if ([type isEqualToString:@"failed"]) {
    [self setPetAnimationState:PetAnimationStateFailed];
  }
}

- (void)setPetAnimationState:(PetAnimationState)state {
  PetView *petView = (PetView *)_window.contentView;
  [petView setAnimationState:state];
}

- (NSRect)bubbleFrameForSize:(NSSize)size {
  NSRect petFrame = _window.frame;
  NSScreen *screen = _window.screen ?: NSScreen.mainScreen;
  NSRect visibleFrame = screen ? screen.visibleFrame : NSMakeRect(0, 0, 1440, 900);
  CGFloat x = NSMidX(petFrame) - size.width / 2.0;
  CGFloat y = NSMaxY(petFrame) + 10;

  if (x < NSMinX(visibleFrame) + 12) {
    x = NSMinX(visibleFrame) + 12;
  }
  if (x + size.width > NSMaxX(visibleFrame) - 12) {
    x = NSMaxX(visibleFrame) - size.width - 12;
  }
  if (y + size.height > NSMaxY(visibleFrame) - 12) {
    y = NSMinY(petFrame) - size.height - 10;
  }
  if (y < NSMinY(visibleFrame) + 12) {
    y = NSMinY(visibleFrame) + 12;
  }

  return NSMakeRect(x, y, size.width, size.height);
}

- (NSDate *)dateFromCodexTimestamp:(NSString *)timestamp {
  if (timestamp.length == 0) {
    return nil;
  }
  static NSISO8601DateFormatter *formatter;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  });
  return [formatter dateFromString:timestamp];
}

- (NSString *)cleanedSingleLine:(NSString *)value {
  if (value.length == 0) {
    return @"";
  }
  NSString *cleaned = [value stringByReplacingOccurrencesOfString:@"\r" withString:@" "];
  cleaned = [cleaned stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
  while ([cleaned containsString:@"  "]) {
    cleaned = [cleaned stringByReplacingOccurrencesOfString:@"  " withString:@" "];
  }
  return [cleaned stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

- (NSString *)truncate:(NSString *)value maxLength:(NSUInteger)maxLength {
  if (value.length <= maxLength) {
    return value ?: @"";
  }
  return [[value substringToIndex:maxLength] stringByAppendingString:@"..."];
}

- (NSString *)stringValue:(id)value {
  if ([value isKindOfClass:NSString.class]) {
    return value;
  }
  if ([value respondsToSelector:@selector(stringValue)]) {
    return [value stringValue];
  }
  return @"";
}

- (NSString *)restoredNotificationModeFromArgument:(NSString *)mode {
  NSString *saved = [NSUserDefaults.standardUserDefaults stringForKey:kNotificationModeDefaultsKey];
  NSString *candidate = saved.length > 0 ? saved : mode;
  return [candidate isEqualToString:kNotificationModeProgress] ? kNotificationModeProgress : kNotificationModeCritical;
}

- (CGFloat)restoredPetWidthFromArgument:(NSString *)widthArgument {
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  if ([defaults objectForKey:kPetSizeDefaultsKey]) {
    return MIN(280, MAX(96, round([defaults doubleForKey:kPetSizeDefaultsKey])));
  }
  CGFloat width = widthArgument.length > 0 ? widthArgument.doubleValue : 160;
  return MIN(280, MAX(96, round(width)));
}

- (NSSize)petSizeForWidth:(CGFloat)width {
  CGFloat normalizedWidth = MIN(280, MAX(96, round(width)));
  return NSMakeSize(normalizedWidth, round(normalizedWidth / kSpriteAspectRatio));
}

- (CGFloat)restoredXForSize:(NSSize)size {
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  if ([defaults objectForKey:@"duotuanPetWindowX"]) {
    return [defaults doubleForKey:@"duotuanPetWindowX"];
  }
  NSRect visibleFrame = NSScreen.mainScreen ? NSScreen.mainScreen.visibleFrame : NSMakeRect(0, 0, 1440, 900);
  return NSMaxX(visibleFrame) - size.width - 32;
}

- (CGFloat)restoredYForSize:(NSSize)size {
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  if ([defaults objectForKey:@"duotuanPetWindowY"]) {
    return [defaults doubleForKey:@"duotuanPetWindowY"];
  }
  NSRect visibleFrame = NSScreen.mainScreen ? NSScreen.mainScreen.visibleFrame : NSMakeRect(0, 0, 1440, 900);
  return NSMinY(visibleFrame) + 92;
}

- (BOOL)acquireSingleInstanceLock:(NSString *)pidFilePath {
  _ownsPidFile = NO;
  NSFileManager *fileManager = NSFileManager.defaultManager;
  [fileManager createDirectoryAtPath:pidFilePath.stringByDeletingLastPathComponent
          withIntermediateDirectories:YES
                           attributes:nil
                                error:nil];

  NSString *existing = [NSString stringWithContentsOfFile:pidFilePath encoding:NSUTF8StringEncoding error:nil];
  pid_t existingPid = existing ? (pid_t)existing.intValue : 0;
  if (existingPid > 0 && kill(existingPid, 0) == 0) {
    return NO;
  }

  NSString *currentPid = [NSString stringWithFormat:@"%d\n", getpid()];
  BOOL wrote = [currentPid writeToFile:pidFilePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
  _ownsPidFile = wrote;
  return wrote;
}

- (void)cleanupPidFile {
  if (!_pidFilePath || !_ownsPidFile) {
    return;
  }

  NSString *existing = [NSString stringWithContentsOfFile:_pidFilePath encoding:NSUTF8StringEncoding error:nil];
  pid_t existingPid = existing ? (pid_t)existing.intValue : 0;
  if (existingPid == getpid()) {
    [NSFileManager.defaultManager removeItemAtPath:_pidFilePath error:nil];
  }
  _ownsPidFile = NO;
}

- (NSString *)valueAfter:(NSString *)flag inArguments:(NSArray<NSString *> *)arguments {
  NSUInteger index = [arguments indexOfObject:flag];
  if (index == NSNotFound || index + 1 >= arguments.count) {
    return nil;
  }
  return arguments[index + 1];
}

- (NSString *)defaultSpritesheetPath {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".codex/pets/duotuan/spritesheet.webp"];
}

- (NSString *)defaultPidFilePath {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".codex/duotuan-pet.pid"];
}

- (NSString *)defaultCodexHomePath {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".codex"];
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    AppDelegate *delegate = [[AppDelegate alloc] init];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
