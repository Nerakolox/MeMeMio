import { useState } from 'react'
import {
  Bell,
  Calendar,
  CreditCard,
  Mail,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  )
}

function DemoCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="flex min-h-[120px] flex-wrap items-center justify-center gap-3 p-6">
        {children}
      </div>
    </div>
  )
}

export function UiPage() {
  const [checked, setChecked] = useState(false)
  const [switched, setSwitched] = useState(false)
  const [slider, setSlider] = useState([50])

  return (
    <div className="mx-auto w-full max-w-4xl space-y-12 py-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">组件</h1>
        <p className="text-muted-foreground">
          shadcn/ui 组件库参照页 —— new-york + zinc 主题，与官网同款样式。
        </p>
      </div>

      <Section title="按钮" description="Button —— 六种变体 × 四种尺寸">
        <DemoCard>
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
        </DemoCard>
        <DemoCard>
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon">
            <Plus className="h-4 w-4" />
          </Button>
        </DemoCard>
      </Section>

      <Section title="徽标" description="Badge —— 状态标签">
        <DemoCard>
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="outline">Outline</Badge>
        </DemoCard>
      </Section>

      <Section title="表单" description="Input / Textarea / Checkbox / Switch / Radio / Select / Slider">
        <div className="grid gap-4">
          <DemoCard>
            <div className="grid w-full max-w-sm gap-2">
              <Label htmlFor="name">名称</Label>
              <Input id="name" placeholder="输入名称" />
              <Label htmlFor="note">备注</Label>
              <Textarea id="note" placeholder="多行文本" />
            </div>
          </DemoCard>
          <DemoCard>
            <div className="flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) => setChecked(v === true)}
                />
                勾选（{checked ? '已选' : '未选'}）
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={switched}
                  onCheckedChange={(v) => setSwitched(v === true)}
                />
                开关（{switched ? '开' : '关'}）
              </label>
              <RadioGroup defaultValue="a" className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="a" /> 甲
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="b" /> 乙
                </label>
              </RadioGroup>
            </div>
          </DemoCard>
          <DemoCard>
            <div className="flex w-full max-w-sm flex-col gap-6">
              <Select>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择一个模型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>视觉模型</SelectLabel>
                    <SelectItem value="gpt">GPT-4o</SelectItem>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="gemini">Gemini</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <div className="space-y-2">
                <span className="text-sm text-muted-foreground">
                  滑动条：{slider[0]}
                </span>
                <Slider
                  value={slider}
                  onValueChange={setSlider}
                  max={100}
                  step={1}
                />
              </div>
            </div>
          </DemoCard>
        </div>
      </Section>

      <Section title="卡片与布局" description="Card / Separator / Skeleton / Progress / ScrollArea">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>卡片标题</CardTitle>
              <CardDescription>这是卡片的描述文字。</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                内容区。表情包卡片继续走产品自己的实现，这里只是演示组件样式。
              </p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">确定</Button>
              <Button size="sm" variant="outline">
                取消
              </Button>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>加载态与进度</CardTitle>
              <CardDescription>骨架屏与进度条</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </div>
              <Progress value={66} />
            </CardContent>
          </Card>
        </div>
        <DemoCard>
          <div className="flex w-full max-w-md flex-col gap-4">
            <div className="flex items-center gap-3">
              <span className="text-sm">左</span>
              <Separator className="flex-1" />
              <span className="text-sm">右</span>
            </div>
            <ScrollArea className="h-24 rounded-md border">
              <div className="p-4 text-sm text-muted-foreground">
                {Array.from({ length: 12 }, (_, i) => (
                  <p key={i} className="py-1">
                    第 {i + 1} 行，超出高度后右侧出现滚动条。
                  </p>
                ))}
              </div>
            </ScrollArea>
          </div>
        </DemoCard>
      </Section>

      <Section title="导航" description="Tabs / DropdownMenu / Tooltip / Accordion">
        <div className="grid gap-4">
          <DemoCard>
            <Tabs defaultValue="first" className="w-full max-w-sm">
              <TabsList>
                <TabsTrigger value="first">第一个</TabsTrigger>
                <TabsTrigger value="second">第二个</TabsTrigger>
                <TabsTrigger value="third">第三个</TabsTrigger>
              </TabsList>
              <TabsContent value="first">
                <p className="text-sm text-muted-foreground">第一个面板的内容。</p>
              </TabsContent>
              <TabsContent value="second">
                <p className="text-sm text-muted-foreground">第二个面板的内容。</p>
              </TabsContent>
              <TabsContent value="third">
                <p className="text-sm text-muted-foreground">第三个面板的内容。</p>
              </TabsContent>
            </Tabs>
          </DemoCard>
          <DemoCard>
            <div className="flex flex-wrap items-center gap-3">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    打开菜单
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-48">
                  <DropdownMenuLabel>我的账户</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>
                    <User className="h-4 w-4" /> 资料
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Settings className="h-4 w-4" /> 设置
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked>允许通知</DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem>自动保存</DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon">
                      <Bell className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>悬停或聚焦时显示</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </DemoCard>
          <DemoCard>
            <Accordion type="single" collapsible className="w-full max-w-md">
              <AccordionItem value="a">
                <AccordionTrigger>什么是 Mememio？</AccordionTrigger>
                <AccordionContent>
                  一个本地优先的表情包库，导入、打标、搜索、一键发送。
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="b">
                <AccordionTrigger>为什么用 shadcn？</AccordionTrigger>
                <AccordionContent>
                  组件拷进仓库、样式随项目走 token，不做黑盒依赖。
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </DemoCard>
        </div>
      </Section>

      <Section title="覆盖层" description="Dialog / AlertDialog / Popover">
        <DemoCard>
          <div className="flex flex-wrap items-center gap-3">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">打开对话框</Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>编辑资料</DialogTitle>
                  <DialogDescription>
                    对谁可见等设置会在这里调整。
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="username" className="text-right">
                      用户名
                    </Label>
                    <Input id="username" defaultValue="mememio" className="col-span-3" />
                  </div>
                </div>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">取消</Button>
                  </DialogClose>
                  <Button type="submit">保存</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive">删除确认</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认删除？</AlertDialogTitle>
                  <AlertDialogDescription>
                    此操作无法撤销，删除后这张图会从库里移除。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction>删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">
                  <Calendar className="h-4 w-4" /> 弹层
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <div className="space-y-2">
                  <h4 className="font-medium leading-none">尺寸</h4>
                  <p className="text-sm text-muted-foreground">
                    设置导入时是否压缩原图。
                  </p>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </DemoCard>
      </Section>

      <Section title="反馈" description="Alert —— 行内状态，不自动消失">
        <DemoCard>
          <div className="flex w-full max-w-md flex-col gap-3">
            <Alert>
              <Search className="h-4 w-4" />
              <AlertTitle>搜索已降级</AlertTitle>
              <AlertDescription>
                向量通道不可用，本次结果基于关键词匹配。
              </AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <CreditCard className="h-4 w-4" />
              <AlertTitle>打标失败</AlertTitle>
              <AlertDescription>上游返回 401，请检查 API Key。</AlertDescription>
            </Alert>
          </div>
        </DemoCard>
      </Section>

      <Section title="数据展示" description="Avatar / Table">
        <div className="grid gap-4">
          <DemoCard>
            <div className="flex items-center gap-4">
              <Avatar>
                <AvatarFallback>MM</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>
                  <Mail className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              <div className="text-sm">
                <p className="font-medium">示例用户</p>
                <p className="text-muted-foreground">user@example.com</p>
              </div>
            </div>
          </DemoCard>
          <DemoCard>
            <Table>
              <TableCaption>最近导入的图。</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>文件名</TableHead>
                  <TableHead>标签</TableHead>
                  <TableHead className="text-right">状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">cat.png</TableCell>
                  <TableCell>猫、表情包</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="secondary">已打标</Badge>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">dog.gif</TableCell>
                  <TableCell>狗</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline">待打标</Badge>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </DemoCard>
        </div>
      </Section>
    </div>
  )
}
